package computehost

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/vmhost"
)

type Config struct {
	Data, BootID, HostID, Pool, Addr string
	Shape                            hostwire.Shape
	Slots                            int
	Images                           store.Store
	Mounts                           *image.Manager
	Launcher                         *vmhost.Launcher
	Post                             func(context.Context, string, any, any) error
}

type Host struct {
	Config
	ctx              context.Context
	cancel           context.CancelFunc
	db               *sql.DB
	images           images
	mu               sync.Mutex // VM inventory, persisted records and current registration.
	pollMu           sync.Mutex
	epoch            int64
	registered       bool
	registeredImages []string
	vms              map[string]*session
	work             sync.WaitGroup
}

type bootState struct {
	BootID    string `json:"bootID"`
	BootEpoch int64  `json:"bootEpoch"`
}

type record struct {
	Spec       hostwire.BootSpec
	Slot       int
	StartedAt  *int64
	Ended      *hostwire.Ended
	Stop       *hostwire.Stop
	EndCode    string
	StopResult *hostwire.Ended
	Pending    *checkpointIntent
}

type session struct {
	row record     // guarded by Host.mu
	op  sync.Mutex // serializes boot, stop, and checkpoint
	vm  *vmhost.VM // guarded by Host.mu
}

func Open(ctx context.Context, c Config) (*Host, error) {
	ctx, cancel := context.WithCancel(ctx)
	db, err := sql.Open("sqlite3", filepath.Join(c.Data, "compute.db")+"?_journal_mode=WAL&_synchronous=FULL")
	if err != nil {
		cancel()
		return nil, err
	}
	db.SetMaxOpenConns(1)
	h := &Host{Config: c, ctx: ctx, cancel: cancel, db: db, vms: make(map[string]*session), images: images{dir: filepath.Join(c.Data, "images"), store: c.Images}}
	if err := h.load(); err != nil {
		h.Close()
		return nil, err
	}
	return h, nil
}

func (h *Host) load() error {
	if _, err := h.db.Exec(`CREATE TABLE IF NOT EXISTS vms (
		id TEXT PRIMARY KEY, lineage TEXT NOT NULL, ref TEXT NOT NULL, image TEXT NOT NULL, slot INTEGER NOT NULL,
		holder TEXT NOT NULL, epoch INTEGER NOT NULL, phase TEXT NOT NULL, startedAt INTEGER, endedAt INTEGER,
		endedAcked INTEGER NOT NULL DEFAULT 0, record BLOB NOT NULL)`); err != nil {
		return err
	}
	h.images.scan()
	raw, err := os.ReadFile(filepath.Join(h.Data, "boot.json"))
	if err == nil {
		var boot bootState
		if err := json.Unmarshal(raw, &boot); err != nil {
			return err
		}
		if boot.BootID == h.BootID {
			h.epoch = boot.BootEpoch
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	rows, err := h.db.Query("SELECT record FROM vms WHERE endedAcked = 0")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		var r record
		if err := rows.Scan(&raw); err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			return err
		}
		h.vms[r.Spec.ID] = &session{row: r}
	}
	return rows.Err()
}

func (h *Host) save(s *session, r record) error {
	phase := "booting"
	switch {
	case r.Ended != nil:
		phase = "finished"
	case r.Stop != nil:
		phase = "stopping"
	case r.StartedAt != nil:
		phase = "running"
	}
	var endedAt *int64
	if r.Ended != nil {
		endedAt = &r.Ended.At
	}
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	q := r.Spec
	_, err = h.db.Exec(`INSERT INTO vms(id,lineage,ref,image,slot,holder,epoch,phase,startedAt,endedAt,record)
		VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
		slot=excluded.slot, phase=excluded.phase, startedAt=excluded.startedAt, endedAt=excluded.endedAt, record=excluded.record`,
		q.ID, q.Lineage, q.Ref, q.Image, r.Slot, q.Lease.Holder.String(), q.Lease.Epoch, phase, r.StartedAt, endedAt, raw)
	if err == nil {
		s.row = r
	}
	return err
}

func (h *Host) Close() {
	h.cancel()
	h.mu.Lock()
	h.mu.Unlock()
	h.work.Wait()
	h.db.Close()
}

func (h *Host) register(ctx context.Context) error {
	var result hostwire.Registered
	q := hostwire.Register{BootID: h.BootID, Pool: h.Pool, Addr: h.Addr, Shape: h.Shape, Slots: h.Slots,
		Features: []string{"session"}, Images: h.images.list()}
	if err := h.Post(ctx, "/register", q, &result); err != nil {
		return err
	}
	if result.BootEpoch <= 0 {
		return errors.New("tier returned invalid boot epoch")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.epoch != result.BootEpoch {
		raw, err := json.Marshal(bootState{h.BootID, result.BootEpoch})
		if err != nil {
			return err
		}
		if err := store.Atomic(filepath.Join(h.Data, "boot.json"), raw); err != nil {
			return err
		}
		h.epoch = result.BootEpoch
	}
	h.registered, h.registeredImages = true, q.Images
	return nil
}

// Recover runs before the listener and heartbeat start.
func (h *Host) Recover(ctx context.Context) error {
	if err := h.register(ctx); err != nil {
		return err
	}
	for id, s := range h.vms {
		r := s.row
		if r.Spec.Lease.Holder.Host != h.HostID || r.Spec.Lease.Holder.Boot != h.epoch {
			// Register fences the old boot and the tier ends its VMs as host_lost.
			if err := h.cleanup(ctx, id); err != nil {
				return err
			}
			if err := h.drop(id); err != nil {
				return err
			}
			continue
		}
		if r.Ended != nil || r.StopResult != nil {
			continue
		}
		vm, err := h.Launcher.Adopt(id)
		if err == nil {
			s.vm = vm
			err = h.Mounts.SessionStreams(ctx, id, vm.GuestSocket(), vm.GuestUID(), r.StartedAt == nil)
			if err == nil {
				var inventory vmhost.Reply
				inventory, err = vm.Reconnect(ctx)
				if err == nil && r.StartedAt == nil && inventory["tree"] == r.Spec.Tree && r.Stop == nil {
					now := time.Now().UnixMilli()
					r.StartedAt = &now
					r.Slot = vm.Slot()
					err = h.save(s, r)
				}
				if err == nil && r.Pending == nil && inventory["checkpointPending"] == true {
					err = h.checkpointed(ctx, vm, "", true)
				}
			}
			if err == nil && r.StartedAt == nil && r.Stop == nil {
				_, err = guestRequest(ctx, vm, map[string]any{"op": "camelfs_apply", "jobId": id, "timeoutMs": h.Mounts.ApplyMax.Milliseconds()})
				if err == nil {
					now := time.Now().UnixMilli()
					r.StartedAt = &now
					r.Slot = vm.Slot()
					err = h.save(s, r)
				}
			}
		}
		if err != nil {
			slog.Warn("compute_reconnect_failed", "vm", id, "error", err)
			if e := h.markStop(s, false, endCode(r)); e != nil {
				return e
			}
		}
	}
	return nil
}

func endCode(r record) string {
	if r.StartedAt == nil {
		return "start_failed"
	}
	return "stopped"
}

func (h *Host) drop(id string) error {
	if _, err := h.db.Exec("DELETE FROM vms WHERE id = ?", id); err != nil {
		return err
	}
	delete(h.vms, id)
	return nil
}

func (h *Host) Run(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if err := h.poll(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("compute_heartbeat_failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (h *Host) poll(ctx context.Context) error {
	h.pollMu.Lock()
	defer h.pollMu.Unlock()
	h.mu.Lock()
	registered := h.registered && slices.Equal(h.registeredImages, h.images.list())
	h.mu.Unlock()
	if !registered {
		registration, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := h.register(registration)
		cancel()
		if err != nil {
			return err
		}
	}
	h.mu.Lock()
	q := hostwire.Heartbeat{BootEpoch: h.epoch, At: time.Now().UnixMilli(), Free: h.Slots, Running: []hostwire.Running{}}
	for id, s := range h.vms {
		r := s.row
		if r.Spec.Lease.Holder.Boot != q.BootEpoch {
			if r.Ended != nil {
				if err := h.drop(id); err != nil {
					h.mu.Unlock()
					return err
				}
				continue
			}
			h.queueStopLocked(s, false, endCode(r))
			continue
		}
		q.Running = append(q.Running, hostwire.Running{ID: id, StartedAt: r.StartedAt, Finished: r.Ended != nil})
		if r.Ended == nil {
			q.Free--
		}
		if r.Stop != nil && r.Ended == nil {
			h.queueStopLocked(s, r.Stop.Checkpoint, r.EndCode)
		}
		if s.vm != nil && s.vm.Exited() && r.Ended == nil {
			h.queueStopLocked(s, false, endCode(r))
		}
	}
	h.mu.Unlock()
	var reply hostwire.HeartbeatReply
	hbCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	err := h.Post(hbCtx, "/heartbeat", q, &reply)
	cancel()
	if staleEpoch(err) {
		h.mu.Lock()
		h.registered = false
		h.mu.Unlock()
		return h.register(ctx)
	}
	if err == nil && reply.BootEpoch == q.BootEpoch {
		h.mu.Lock()
		if h.epoch == q.BootEpoch {
			for _, stop := range reply.Stop {
				if s := h.vms[stop.ID]; s != nil {
					h.queueStopLocked(s, stop.Checkpoint, endCode(s.row))
				}
			}
			for _, spec := range reply.Boot {
				if err := h.bootLocked(spec); err != nil {
					slog.Warn("compute_boot_refused", "vm", spec.ID, "error", err)
				}
			}
		}
		h.mu.Unlock()
	}
	heartbeatErr := err
	// Process the reply before dropping any finished record it may refer to.
	for _, vm := range q.Running {
		path := "/vms/" + url.PathEscape(vm.ID)
		if vm.Finished {
			h.mu.Lock()
			s := h.vms[vm.ID]
			var ended *hostwire.Ended
			if s != nil {
				ended = s.row.Ended
			}
			h.mu.Unlock()
			if ended != nil {
				if err := h.callback(ctx, path+"/ended", ended); err == nil {
					h.mu.Lock()
					err = h.drop(vm.ID)
					h.mu.Unlock()
					if err != nil {
						return err
					}
				} else if staleEpoch(err) {
					h.mu.Lock()
					h.registered = false
					h.mu.Unlock()
					return h.register(ctx)
				}
			}
		}
	}
	return heartbeatErr
}

func staleEpoch(err error) bool {
	var status *tierError
	return errors.As(err, &status) && status.Status == 409 && status.Code == "stale_epoch"
}

func (h *Host) bootLocked(q hostwire.BootSpec) error {
	if h.ctx.Err() != nil {
		return h.ctx.Err()
	}
	if !hostwire.MountID.MatchString(q.ID) || q.ID == "." || q.ID == ".." {
		return invalidRequest
	}
	if _, ok := h.vms[q.ID]; ok {
		return nil
	}
	holder := hostwire.Holder{Host: h.HostID, Boot: h.epoch, Mount: q.ID}
	if !h.registered || q.Lease.Holder != holder || q.Lease.Epoch <= 0 {
		return conflict("stale_epoch")
	}
	n, memory := 0, 0
	for _, s := range h.vms {
		if s.row.Ended == nil {
			n++
			if validShape(s.row.Spec.Shape, h.Shape) {
				memory += s.row.Spec.Shape.MemoryMiB
			}
		}
	}
	if n >= h.Slots || q.Shape.MemoryMiB > 0 && q.Shape.MemoryMiB <= h.Shape.MemoryMiB && q.Shape.MemoryMiB > h.Shape.MemoryMiB-memory {
		return conflict("no_free_slot")
	}
	s := new(session)
	r := record{Spec: q, Slot: -1}
	if err := h.save(s, r); err != nil {
		return err
	}
	h.vms[q.ID] = s
	s.op.Lock()
	h.work.Add(1)
	go func() { defer h.work.Done(); defer s.op.Unlock(); h.boot(s, q) }()
	return nil
}

func (h *Host) boot(s *session, q hostwire.BootSpec) {
	ctx, cancel := context.WithTimeout(h.ctx, h.Mounts.ApplyMax+time.Minute)
	defer cancel()
	var imageTime, mountTime, firstExec time.Duration
	err := func() error {
		if !validShape(q.Shape, h.Shape) || q.Session == nil {
			return errors.New("invalid session or VM shape")
		}
		start := time.Now()
		path, err := h.images.ensure(ctx, q.Image, q.Shape.DiskMiB)
		imageTime = time.Since(start)
		if err != nil {
			return err
		}
		start = time.Now()
		m, err := h.Mounts.Mount(ctx, image.Request{JobID: q.ID, Lineage: q.Lineage, Tree: q.Tree, Parent: q.Parent, Session: true, Fence: &refs.Fence{Holder: q.Lease.Holder.String(), Epoch: q.Lease.Epoch}})
		mountTime = time.Since(start)
		if err != nil {
			return err
		}
		start = time.Now()
		vm, err := h.Launcher.Boot(ctx, q.ID, vmhost.Shape{VCPUs: q.Shape.VCPUs, MemoryMiB: q.Shape.MemoryMiB, DiskMiB: int64(q.Shape.DiskMiB)}, vmhost.Boot{Repo: m.Image, Image: path, Session: true, Internet: q.Internet})
		if err != nil {
			return err
		}
		h.mu.Lock()
		r := s.row
		r.Slot = vm.Slot()
		err = h.save(s, r)
		h.mu.Unlock()
		if err != nil {
			return err
		}
		if err := h.Mounts.SessionStreams(ctx, q.ID, vm.GuestSocket(), vm.GuestUID(), true); err != nil {
			return err
		}
		_, err = guestRequest(ctx, vm, map[string]any{"op": "camelfs_apply", "jobId": q.ID, "timeoutMs": h.Mounts.ApplyMax.Milliseconds()})
		firstExec = time.Since(start)
		if err != nil {
			return err
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		r = s.row
		now := time.Now().UnixMilli()
		r.Slot, r.StartedAt = vm.Slot(), &now
		if err := h.save(s, r); err != nil {
			return err
		}
		s.vm = vm
		return nil
	}()
	slog.Info("compute_boot", "vm", q.ID, "image", ms(imageTime), "mount", ms(mountTime), "first_exec", ms(firstExec), "error", err)
	if err != nil {
		h.failBoot(s, err)
		return
	}
	h.mu.Lock()
	started := s.row.StartedAt
	h.mu.Unlock()
	if err := h.callback(ctx, "/vms/"+url.PathEscape(q.ID)+"/started", hostwire.Started{BootEpoch: q.Lease.Holder.Boot, At: *started}); err != nil {
		slog.Warn("compute_started_callback_failed", "vm", q.ID, "error", err)
	}
}

func (h *Host) markStop(s *session, checkpoint bool, code string) error {
	r := s.row
	if r.Stop != nil || r.Ended != nil {
		return nil
	}
	r.Stop = &hostwire.Stop{Checkpoint: checkpoint}
	r.EndCode = code
	return h.save(s, r)
}

func (h *Host) queueStopLocked(s *session, checkpoint bool, code string) error {
	if h.ctx.Err() != nil {
		return h.ctx.Err()
	}
	if err := h.markStop(s, checkpoint, code); err != nil {
		return err
	}
	if s.row.Ended == nil && s.op.TryLock() {
		h.work.Add(1)
		go func() { defer h.work.Done(); defer s.op.Unlock(); h.stop(s) }()
	}
	return nil
}

func (h *Host) stop(s *session) {
	ctx, cancel := context.WithTimeout(h.ctx, 3*time.Minute)
	defer cancel()
	h.mu.Lock()
	r, vm, epoch := s.row, s.vm, h.epoch
	h.mu.Unlock()
	q := r.Spec
	ended := r.StopResult
	if ended == nil {
		ended = &hostwire.Ended{BootEpoch: q.Lease.Holder.Boot, Code: r.EndCode, Version: q.Version}
		if r.Stop.Checkpoint && vm != nil && q.Lease.Holder.Boot == epoch {
			reply, err := h.checkpoint(ctx, s, vm, hostwire.CheckpointRequest{})
			if err != nil {
				ended.CheckpointError = err.Error()
			} else {
				ended.Version = reply.Version
			}
		}
		h.mu.Lock()
		r = s.row
		r.StopResult = ended
		err := h.save(s, r)
		h.mu.Unlock()
		if err != nil {
			slog.Error("compute_stop_record_failed", "vm", q.ID, "error", err)
			return
		}
	}
	if err := h.cleanup(ctx, q.ID); err != nil {
		slog.Warn("compute_cleanup_failed", "vm", q.ID, "error", err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if q.Lease.Holder.Boot != h.epoch {
		if err := h.drop(q.ID); err != nil {
			slog.Error("compute_drop_failed", "vm", q.ID, "error", err)
		}
		return
	}
	finished := *ended
	finished.At = time.Now().UnixMilli()
	r = s.row
	r.Ended = &finished
	if err := h.save(s, r); err != nil {
		slog.Error("compute_end_record_failed", "vm", q.ID, "error", err)
	} else {
		s.vm = nil
	}
}

func (h *Host) cleanup(ctx context.Context, id string) error {
	if err := h.Launcher.Destroy(ctx, id); err != nil {
		return err
	}
	_, err := h.Mounts.Release(ctx, id)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (h *Host) lookup(id string) (*session, *vmhost.VM, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.vms[id]
	if s == nil || s.row.Ended != nil {
		return nil, nil, &httpError{404, "vm_unknown"}
	}
	if s.vm == nil || s.row.StartedAt == nil || s.row.Stop != nil || s.row.Spec.Lease.Holder.Boot != h.epoch {
		return nil, nil, conflict("vm_not_running")
	}
	return s, s.vm, nil
}

func guestRequest(ctx context.Context, vm guestRequester, q any) (vmhost.Reply, error) {
	reply, err := vm.Request(ctx, q, nil)
	if err != nil {
		return nil, err
	}
	if reply["ok"] != true {
		return reply, fmt.Errorf("guest refused request: %v", reply["error"])
	}
	return reply, nil
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func KernelBootID() (string, error) {
	data, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(data))
	if id == "" {
		return "", errors.New("empty kernel boot ID")
	}
	return id, nil
}

func (h *Host) callback(ctx context.Context, path string, body any) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return h.Post(ctx, path, body, nil)
}

func validShape(q, cap hostwire.Shape) bool {
	return q.VCPUs > 0 && q.VCPUs <= cap.VCPUs && q.MemoryMiB > 0 && q.MemoryMiB <= cap.MemoryMiB && q.DiskMiB > 0 && q.DiskMiB <= cap.DiskMiB
}

func (h *Host) failBoot(s *session, err error) {
	if h.ctx.Err() != nil {
		return
	}
	h.mu.Lock()
	saveErr := h.markStop(s, false, "start_failed")
	h.mu.Unlock()
	if saveErr != nil {
		slog.Error("compute_stop_record_failed", "error", saveErr, "bootError", err)
		return
	}
	h.stop(s)
}
