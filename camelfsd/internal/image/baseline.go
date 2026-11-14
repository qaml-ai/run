package image

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
)

const baselineIntent = "baseline.json"

// SessionBaselineTimeout bounds the boot-path handshake on both sides.
const SessionBaselineTimeout = 500 * time.Millisecond

type baselineRecord struct {
	Lineage, Tree, Root string
}

type baselineSnapshot struct {
	dir        string
	size       int64
	tree, base string
}

func (m *Manager) baselineDir() string { return filepath.Join(m.Data, "baselines") }

// StopBaselines cancels publication during daemon shutdown.
func (m *Manager) StopBaselines() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.baselineCancel != nil {
		m.baselineCancel()
	}
}

func (m *Manager) reserveBaseline(v *Mount) (*baselineSnapshot, error) {
	info, err := os.Stat(v.Dest)
	if err != nil {
		return nil, err
	}
	size := info.Size()
	m.mu.Lock()
	if err := m.baselineCtx.Err(); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	if size <= 0 || size > m.BaselineDiskMax-m.baselineBytes {
		m.mu.Unlock()
		return nil, fmt.Errorf("baseline disk cap: need %d bytes, limit %d", size, m.BaselineDiskMax)
	}
	m.baselineBytes += size
	m.baselineWork.Add(1)
	m.mu.Unlock()
	snap := &baselineSnapshot{size: size, tree: v.Tree, base: v.Root}
	snap.dir, err = os.MkdirTemp(m.baselineDir(), v.JobID+"-")
	if err != nil {
		m.discardBaseline(snap)
		return nil, err
	}
	return snap, nil
}

func (m *Manager) discardBaseline(snap *baselineSnapshot) {
	if snap.dir != "" {
		if err := os.Remove(snap.path()); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Error("compute_baseline_cleanup_failed", "path", snap.path(), "error", err)
			m.baselineWork.Done()
			return
		}
		// A failed RecordTree leaves the intent for restart recovery.
		_ = os.Remove(snap.dir)
	}
	m.mu.Lock()
	m.baselineBytes -= snap.size
	m.mu.Unlock()
	m.baselineWork.Done()
}

func (s *baselineSnapshot) path() string { return filepath.Join(s.dir, "image.img") }

func (m *Manager) NeedsBaseline(id string) bool {
	v := m.lookup(id)
	if v == nil {
		return false
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	_, err := m.Refs.TreeRoot(v.Lineage, v.Tree)
	return v.needsBaseline && v.streams != nil && errors.Is(err, sql.ErrNoRows)
}

// SessionBaseline captures a snapshot and waits for the guest to thaw. Pass
// the returned function to the background only once the session is started.
func (m *Manager) SessionBaseline(ctx context.Context, id string, freeze func(context.Context) error) (func(), func()) {
	v := m.lookup(id)
	if v == nil {
		return nil, nil
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.needsBaseline || v.streams == nil || v.State == "released" {
		return nil, nil
	}
	start := time.Now()
	snap, err := m.reserveBaseline(v)
	if err != nil {
		logBaseline(id, v.Tree, start, 0, Checkpoint{}, err)
		return nil, nil
	}
	// The guest's syncfs reaches Firecracker, not the host file: its writes sit in this host's page cache, and the
	// reflink below would have to write them back inside the freeze. Flush them first, outside the freeze budget.
	if err = syncImage(v.Dest); err != nil {
		m.discardBaseline(snap)
		logBaseline(id, v.Tree, start, 0, Checkpoint{}, fmt.Errorf("flushing workspace image: %w", err))
		return nil, nil
	}
	start = time.Now()
	ctx, cancel := context.WithTimeout(ctx, SessionBaselineTimeout)
	defer cancel()
	stop := context.AfterFunc(m.baselineCtx, cancel)
	defer stop()
	armed := make(chan struct{})
	guest := make(chan error, 1)
	go func() {
		<-armed
		guest <- freeze(ctx)
		cancel()
	}()
	phase := "connecting to guest"
	c, closeStream, err := v.streams.acceptCheckpoint(ctx, armed)
	if err == nil {
		deadline, _ := ctx.Deadline()
		c.SetDeadline(deadline)
		stop := context.AfterFunc(ctx, func() { c.Close() })
		if err = wire.Send(c, map[string]bool{"ready": true}); err == nil {
			phase = "waiting for workspace freeze"
			var header wire.Header
			if err = wire.JSON(c, &header); err == nil {
				phase = "capturing workspace snapshot"
				err = snap.capture(v, c, header)
				if err == nil {
					phase = "waiting for guest thaw"
				}
			}
		}
		stop()
		closeStream()
	}
	guestErr := <-guest
	var timeout net.Error
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(guestErr, context.DeadlineExceeded) ||
		(errors.As(err, &timeout) && timeout.Timeout()) {
		err = fmt.Errorf("baseline timed out %s: %w", phase, context.DeadlineExceeded)
	} else {
		err = errors.Join(err, guestErr)
	}
	freezeMs := ms(start)
	if err != nil {
		m.discardBaseline(snap)
		logBaseline(id, v.Tree, start, freezeMs, Checkpoint{}, err)
		return nil, nil
	}
	return func() { m.publishCapturedBaseline(v, snap, start, freezeMs) },
		func() { m.discardBaseline(snap) }
}

// The guest sends this header only while frozen. Publication syncs the
// promoted image after the guest is thawed.
func (s *baselineSnapshot) capture(v *Mount, c net.Conn, h wire.Header) error {
	if h.V != 1 || h.Kind != "baseline" || h.JobID != v.JobID || h.BaseTree != v.Tree {
		return errors.New("baseline header mismatch")
	}
	if err := cloneImage(v.Dest, s.path(), false); err != nil {
		return err
	}
	return wire.Send(c, map[string]bool{"ack": true})
}

func (m *Manager) publishCapturedBaseline(v *Mount, snap *baselineSnapshot, start time.Time, freezeMs float64) {
	defer m.discardBaseline(snap)
	ctx := m.baselineCtx
	var point Checkpoint
	select {
	case m.baselineSlot <- struct{}{}:
		defer func() { <-m.baselineSlot }()
	case <-ctx.Done():
		logBaseline(v.JobID, snap.tree, start, freezeMs, point, ctx.Err())
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	err := m.publishBaseline(ctx, v, snap, &point)
	logBaseline(v.JobID, snap.tree, start, freezeMs, point, err)
}

func logBaseline(id, tree string, start time.Time, freezeMs float64, point Checkpoint, err error) {
	slog.Info("compute_baseline", "vm", id, "tree", tree, "freezeMs", freezeMs, "hashMs", point.HashMs,
		"uploadMs", point.UploadMs, "chunks", point.ChangedChunks, "ms", ms(start), "error", err)
}

func (m *Manager) publishBaseline(ctx context.Context, v *Mount, snap *baselineSnapshot, point *Checkpoint) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	base, err := m.mountRoot(ctx, v.Lineage, snap.base)
	if err != nil {
		return err
	}
	captured := Request{Lineage: v.Lineage, Root: snap.base}
	r, err := m.uploadSnapshot(ctx, captured, base, snap.path(), snap.tree, []chunk.Range{{Length: base.VirtualSize}}, point)
	if err != nil {
		return err
	}
	if err := m.objects(v.Lineage).Record(ctx, v.Lineage, point.Root, "root", nil); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	// Sync the snapshot before writing an intent that recovery can promote.
	f, err := os.Open(snap.path())
	if err != nil {
		return err
	}
	if err := errors.Join(f.Sync(), f.Close()); err != nil {
		return err
	}
	intent := filepath.Join(snap.dir, baselineIntent)
	raw, err := json.Marshal(baselineRecord{v.Lineage, snap.tree, point.Root})
	if err != nil {
		return err
	}
	if err := store.Atomic(intent, raw); err != nil {
		return err
	}
	pin := snap.dir
	m.protect(pin, r, point.Root)
	defer m.unprotect(pin)
	if err := os.Rename(snap.path(), m.image(point.Root)); err != nil {
		os.Remove(intent)
		return err
	}
	if err := m.Refs.RecordTree(v.Lineage, snap.tree, point.Root); err != nil {
		return err
	}
	if v.State != "released" && v.Tree == snap.tree && v.Root == snap.base {
		m.protect(v.JobID, r, point.Root)
		v.Root, v.Parent.Root, v.Promoted, v.needsBaseline = point.Root, point.Root, true, false
		err = m.save(v)
	}
	m.shareTreeRoot(ctx, v.Lineage, snap.tree, point.Root)
	return errors.Join(os.Remove(intent), err)
}

func (m *Manager) recoverBaselines() error {
	dir := m.baselineDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			if err := m.recoverBaselineIntent(path, "", true); err != nil {
				return err
			}
		}
		if err := os.RemoveAll(path); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) recoverBaseline(v *Mount, share bool) error {
	return m.recoverBaselineIntent(filepath.Dir(v.Dest), v.Lineage, share)
}

func (m *Manager) recoverBaselineIntent(dir, legacyLineage string, share bool) error {
	intent := filepath.Join(dir, baselineIntent)
	raw, err := os.ReadFile(intent)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var record baselineRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return err
	}
	if record.Lineage == "" {
		record.Lineage = legacyLineage
	}
	if !store.Lineage(record.Lineage) || !root.Hex(record.Root, 64) || !root.Hex(record.Tree, 40) {
		return fmt.Errorf("invalid baseline intent in %s", dir)
	}
	if _, err := os.Stat(m.image(record.Root)); errors.Is(err, os.ErrNotExist) && legacyLineage == "" {
		snapshot := filepath.Join(dir, "image.img")
		if _, err := os.Stat(snapshot); err == nil {
			if err := os.Rename(snapshot, m.image(record.Root)); err != nil {
				return err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if _, err := os.Stat(m.image(record.Root)); err == nil {
		db := m.objects(record.Lineage).DB.DB
		_, err := db.Exec(`INSERT INTO tree_roots SELECT ?,?,?,? WHERE NOT EXISTS
			(SELECT 1 FROM tree_roots WHERE lineage=? AND tree=? AND root=?)`,
			record.Lineage, record.Tree, record.Root, m.Now().UnixNano(), record.Lineage, record.Tree, record.Root)
		if err != nil {
			return err
		}
		if share {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			m.shareTreeRoot(ctx, record.Lineage, record.Tree, record.Root)
			cancel()
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Remove(intent)
}

func syncImage(path string) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	err = f.Sync()
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}
