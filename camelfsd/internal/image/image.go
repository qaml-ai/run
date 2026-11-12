package image

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var JobID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)
var ErrNoRoot = errors.New("no-root-for-tree")

type Config struct {
	Data, Cold, NBDListen, HostID string
	ImportAllow                   []string
}
type Manager struct {
	Config
	Store  store.Store
	Cache  *cache.Cache
	Refs   refs.Repository
	mu     sync.Mutex
	mounts map[string]*Mount
}
type Request struct {
	JobID   string `json:"jobId"`
	Lineage string `json:"lineage"`
	Ref     string `json:"ref"`
	Root    string `json:"root"`
	Tree    string `json:"tree"`
	Hydrate bool   `json:"hydrate"`
	Vsock   string `json:"vsock"`
}
type Mount struct {
	Request
	Image                             string  `json:"image"`
	Warm                              bool    `json:"warm"`
	State                             string  `json:"state"`
	LeaseEpoch                        int64   `json:"leaseEpoch"`
	HydratedRegions                   int64   `json:"hydratedRegions"`
	TotalRegions                      int64   `json:"totalRegions"`
	MountMs                           float64 `json:"mountMs"`
	Hydrating                         bool    `json:"hydrating"`
	Dest, MetaLoop, DestLoop, NBD, DM string
	Parent                            refs.Value
	Fence                             refs.Fence
	Snapshot                          int
	Promoted                          bool
	stopRenew                         chan struct{}
}

func New(c Config, s store.Store, cache *cache.Cache, r refs.Repository) (*Manager, error) {
	if c.Cold != "clone" && c.Cold != "prehydrate" {
		return nil, fmt.Errorf("invalid cold mode")
	}
	for _, d := range []string{c.Data, filepath.Join(c.Data, "images"), filepath.Join(c.Data, "mounts")} {
		if e := os.MkdirAll(d, 0700); e != nil {
			return nil, e
		}
	}
	if e := Probe(c.Data); e != nil {
		return nil, e
	}
	if os.Getenv("CAMELFSD_TEST_NO_REFLINK") == "1" {
		log.Print("test mode: reflink probe skipped, plain copies and whole-file checkpoint hashing")
	}
	entries, e := os.ReadDir(filepath.Join(c.Data, "mounts"))
	if e != nil {
		return nil, e
	}
	if len(entries) > 0 {
		return nil, fmt.Errorf("existing mount state requires cleanup before restart")
	}
	return &Manager{Config: c, Store: s, Cache: cache, Refs: r, mounts: map[string]*Mount{}}, nil
}
func ms(t time.Time) float64 { return float64(time.Since(t).Microseconds()) / 1000 }
func (m *Manager) load(ctx context.Context, id string) (root.Root, error) {
	b, e := m.Store.Get(ctx, "r/"+id)
	if e != nil {
		return root.Root{}, e
	}
	if root.Hash(b) != id {
		return root.Root{}, fmt.Errorf("root hash mismatch")
	}
	return root.Decode(b)
}
func (m *Manager) image(id string) string { return filepath.Join(m.Data, "images", id+".img") }
func (m *Manager) save(v *Mount) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	if e = store.Atomic(filepath.Join(filepath.Dir(v.Dest), "state.json"), b); e != nil {
		return e
	}
	return m.Refs.Mount(v.JobID, v.Lineage, v.Ref, v.Root, v.Tree, v.Image, v.State, v.Warm, v.LeaseEpoch)
}
func (m *Manager) Mount(ctx context.Context, q Request) (out *Mount, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := time.Now()
	forms := 0
	for _, v := range []string{q.Ref, q.Root, q.Tree} {
		if v != "" {
			forms++
		}
	}
	if forms != 1 || !JobID.MatchString(q.JobID) || q.JobID == "." || q.JobID == ".." || q.Lineage == "" || q.Root != "" && !root.Hex(q.Root, 64) || q.Tree != "" && !root.Hex(q.Tree, 40) {
		return nil, fmt.Errorf("invalid mount request")
	}
	if m.mounts[q.JobID] != nil {
		return nil, fmt.Errorf("job already mounted")
	}
	var treeRoot string
	if q.Tree != "" {
		id, e := m.Refs.TreeRoot(q.Lineage, q.Tree)
		if errors.Is(e, sql.ErrNoRows) {
			return nil, ErrNoRoot
		}
		if e != nil {
			return nil, e
		}
		q.Ref = "job/" + q.JobID
		if e = m.Refs.Ensure(q.Lineage, q.Ref); e != nil {
			return nil, e
		}
		treeRoot = id
	}
	v := &Mount{Request: q}
	if q.Ref != "" {
		p, e := m.Refs.Get(q.Lineage, q.Ref)
		if e != nil {
			return nil, e
		}
		epoch, e := m.Refs.Lease(q.Lineage, q.Ref, m.HostID+"/"+q.JobID)
		if e != nil {
			return nil, e
		}
		p, e = m.Refs.Get(q.Lineage, q.Ref)
		if e != nil {
			_ = m.Refs.ReleaseLease(q.Lineage, q.Ref, refs.Fence{Holder: m.HostID + "/" + q.JobID, LeaseEpoch: epoch})
			return nil, e
		}
		if treeRoot != "" {
			set := refs.Value{Tree: q.Tree, Root: treeRoot, Owner: "job:" + q.JobID}
			fence := refs.Fence{Holder: m.HostID + "/" + q.JobID, LeaseEpoch: epoch}
			if p.Owner != "" && p.Owner != set.Owner {
				_ = m.Refs.ReleaseLease(q.Lineage, q.Ref, fence)
				return nil, refs.ErrFenced
			}
			if e = m.Refs.CAS(q.Lineage, q.Ref, p.Value, set, fence); e != nil {
				_ = m.Refs.ReleaseLease(q.Lineage, q.Ref, fence)
				return nil, e
			}
			p.Value = set
		}
		v.Fence = refs.Fence{Holder: m.HostID + "/" + q.JobID, LeaseEpoch: epoch}
		v.stopRenew = make(chan struct{})
		go m.renewMount(v.Lineage, v.Ref, v.JobID, v.Fence, v.stopRenew)
		v.LeaseEpoch = epoch
		v.Parent = p.Value
		v.Root = p.Root
		v.Tree = p.Tree
		defer func() {
			if err != nil {
				close(v.stopRenew)
				_ = m.Refs.ReleaseLease(q.Lineage, q.Ref, v.Fence)
			}
		}()
	}
	r, e := m.load(ctx, v.Root)
	if e != nil {
		return nil, e
	}
	v.Tree = r.Tree
	if v.Ref != "" && v.Parent.Tree != r.Tree {
		return nil, fmt.Errorf("ref/root tree mismatch")
	}
	dir := filepath.Join(m.Data, "mounts", q.JobID)
	if e = os.Mkdir(dir, 0700); e != nil {
		return nil, e
	}
	v.Dest = filepath.Join(dir, "image.img")
	v.Image = v.Dest
	defer func() {
		if err != nil {
			_ = m.cleanup(v)
			_ = os.RemoveAll(dir)
		}
	}()
	if _, e = os.Stat(m.image(v.Root)); e == nil {
		e = clone(m.image(v.Root), v.Dest)
		v.Warm = true
		v.State = "warm"
	} else if !os.IsNotExist(e) {
		return nil, e
	} else if m.Cold == "prehydrate" {
		e = m.materialize(ctx, r, v.Dest)
		v.Warm = true
		v.State = "warm"
		if e == nil {
			e = m.promote(v.Dest, v.Root)
		}
	} else {
		e = m.cold(ctx, v, r)
	}
	if e != nil {
		return nil, e
	}
	if v.Ref == "" {
		if v.DM != "" {
			_, e = run(ctx, "blockdev", "--setro", v.Image)
		} else {
			e = os.Chmod(v.Image, 0400)
		}
		if e != nil {
			return nil, e
		}
	}
	v.MountMs = ms(t)
	if e = m.save(v); e != nil {
		return nil, e
	}
	m.mounts[q.JobID] = v
	copy := *v
	return &copy, nil
}
func (m *Manager) materialize(ctx context.Context, r root.Root, p string) error {
	f, e := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	if e = f.Truncate(r.VirtualSize); e != nil {
		return e
	}
	keys := make([]string, 0, len(r.Chunks))
	for o := range r.Chunks {
		keys = append(keys, o)
	}
	e = store.Parallel(ctx, store.Depth(m.Store), keys, func(o string) error {
		b, e := m.Store.Get(ctx, "c/"+r.Chunks[o])
		if e != nil {
			return e
		}
		if root.Hash(b) != r.Chunks[o] || len(b) != int(chunk.Size) {
			return fmt.Errorf("chunk mismatch")
		}
		off, _ := strconv.ParseInt(o, 10, 64)
		_, e = f.WriteAt(b[:min(int64(len(b)), r.VirtualSize-off)], off)
		return e
	})
	if e == nil {
		e = f.Sync()
	}
	return e
}
func (m *Manager) promote(src, id string) error {
	dst := m.image(id)
	if e := os.MkdirAll(filepath.Dir(dst), 0700); e != nil {
		return e
	}
	if _, e := os.Stat(dst); e == nil {
		return nil
	}
	tmp := dst + ".tmp"
	_ = os.Remove(tmp)
	if e := clone(src, tmp); e != nil {
		return e
	}
	return os.Rename(tmp, dst)
}
func run(ctx context.Context, name string, args ...string) (string, error) {
	out, e := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if e != nil {
		return "", fmt.Errorf("%s: %w: %s", name, e, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}
func (m *Manager) cold(ctx context.Context, v *Mount, r root.Root) error {
	f, e := os.OpenFile(v.Dest, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	e = f.Truncate(r.VirtualSize)
	f.Close()
	if e != nil {
		return e
	}
	devices, _ := filepath.Glob("/sys/block/nbd*")
	sortNBD(devices)
	for _, d := range devices {
		if _, e = os.Stat(filepath.Join(d, "pid")); os.IsNotExist(e) {
			v.NBD = "/dev/" + filepath.Base(d)
			break
		}
	}
	if v.NBD == "" {
		return fmt.Errorf("no free nbd device")
	}
	host, port, e := net.SplitHostPort(m.NBDListen)
	if e != nil {
		return e
	}
	if _, e = run(ctx, "nbd-client", "-N", v.Root, host, port, v.NBD, "-C", "4"); e != nil {
		v.NBD = ""
		return e
	}
	v.DestLoop, e = run(ctx, "losetup", "-f", "--show", v.Dest)
	if e != nil {
		return e
	}
	meta := filepath.Join(filepath.Dir(v.Dest), "clone-meta.img")
	f, e = os.OpenFile(meta, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	_, e = f.Write(make([]byte, 64<<20))
	f.Close()
	if e != nil {
		return e
	}
	v.MetaLoop, e = run(ctx, "losetup", "-f", "--show", meta)
	if e != nil {
		return e
	}
	dm := "camelfs-" + v.JobID
	table := fmt.Sprintf("0 %d clone %s %s %s 512 1 no_hydration", r.VirtualSize/512, v.MetaLoop, v.DestLoop, v.NBD)
	if _, e = run(ctx, "dmsetup", "create", dm, "--table", table); e != nil {
		return e
	}
	v.DM = dm
	v.Image = "/dev/mapper/" + dm
	v.State = "cold"
	v.TotalRegions = (r.VirtualSize + chunk.Size - 1) / chunk.Size
	if v.Hydrate {
		for _, msg := range []string{"hydration_batch_size 64", "hydration_threshold 64", "enable_hydration"} {
			if _, e = run(ctx, "dmsetup", "message", dm, "0", msg); e != nil {
				return e
			}
		}
		v.State = "hydrating"
		v.Hydrating = true
	}
	return nil
}
func (m *Manager) status(ctx context.Context, v *Mount) error {
	if v.DM == "" {
		return nil
	}
	s, e := run(ctx, "dmsetup", "status", v.DM)
	if e != nil {
		return e
	}
	fields := strings.Fields(s)
	if len(fields) < 7 {
		return fmt.Errorf("invalid clone status: %s", s)
	}
	a, b, ok := strings.Cut(fields[6], "/")
	if !ok {
		return fmt.Errorf("invalid hydration status")
	}
	v.HydratedRegions, e = strconv.ParseInt(a, 10, 64)
	if e != nil {
		return e
	}
	v.TotalRegions, e = strconv.ParseInt(b, 10, 64)
	if e != nil {
		return e
	}
	if v.TotalRegions > 0 && v.HydratedRegions == v.TotalRegions {
		v.State = "hydrated"
		v.Hydrating = false
	}
	return nil
}
func (m *Manager) Status(ctx context.Context, id string) (*Mount, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v := m.mounts[id]
	if v == nil {
		return nil, os.ErrNotExist
	}
	if e := m.status(ctx, v); e != nil {
		return nil, e
	}
	c := *v
	return &c, nil
}
func (m *Manager) cleanup(v *Mount) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if v.DM != "" {
		if _, e := run(ctx, "dmsetup", "remove", v.DM); e != nil {
			return e
		}
		v.DM = ""
	}
	for _, p := range []*string{&v.MetaLoop, &v.DestLoop} {
		if *p != "" {
			if _, e := run(ctx, "losetup", "-d", *p); e != nil {
				return e
			}
			*p = ""
		}
	}
	if v.NBD != "" {
		if _, e := run(ctx, "nbd-client", "-d", v.NBD); e != nil {
			return e
		}
		v.NBD = ""
	}
	return nil
}
func (m *Manager) Release(ctx context.Context, id string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v := m.mounts[id]
	if v == nil {
		return false, os.ErrNotExist
	}
	if e := m.status(ctx, v); e != nil {
		return false, e
	}
	if v.State == "hydrated" {
		if _, e := run(ctx, "dmsetup", "suspend", v.DM); e != nil {
			return false, e
		}
		matches, e := m.matches(ctx, v.Dest, v.Root)
		if e == nil && matches {
			e = m.promote(v.Dest, v.Root)
			if e == nil {
				v.Promoted = true
			}
		}
		_, re := run(context.Background(), "dmsetup", "resume", v.DM)
		if e != nil {
			return false, e
		}
		if re != nil {
			return false, re
		}
	}
	if e := m.cleanup(v); e != nil {
		return false, e
	}
	if v.Ref != "" {
		if e := m.Refs.ReleaseLease(v.Lineage, v.Ref, v.Fence); e != nil && !errors.Is(e, refs.ErrFenced) {
			return false, e
		}
	}
	if e := os.RemoveAll(filepath.Dir(v.Dest)); e != nil {
		return false, e
	}
	if e := m.Refs.DropMount(id); e != nil {
		return false, e
	}
	if v.stopRenew != nil {
		close(v.stopRenew)
	}
	delete(m.mounts, id)
	return v.Promoted, nil
}

// Renewal must not wait on the operation mutex: hashing or hydration can take
// longer than a lease, including while another mount is being prepared.
func (m *Manager) renewMount(lineage, name, job string, fence refs.Fence, stop <-chan struct{}) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			if e := m.Refs.Renew(lineage, name, fence); e != nil {
				log.Printf("op=renew jobId=%s error=%v", job, e)
			}
		}
	}
}
func (m *Manager) Close() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.mounts))
	for id := range m.mounts {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		if _, e := m.Release(context.Background(), id); e != nil {
			log.Printf("op=cleanup jobId=%s error=%v", id, e)
		}
	}
}

// A hydrated destination may contain uncheckpointed writes; it must never be
// promoted under its immutable origin id unless its bytes still match.
func (m *Manager) matches(ctx context.Context, p, id string) (bool, error) {
	r, e := m.load(ctx, id)
	if e != nil {
		return false, e
	}
	f, e := os.Open(p)
	if e != nil {
		return false, e
	}
	defer f.Close()
	same := true
	e = (chunk.Chunker{}).File(f, r.VirtualSize, func(o int64, h string, _ []byte) error {
		if h != r.Chunks[strconv.FormatInt(o, 10)] {
			same = false
		}
		return nil
	})
	return same, e
}
