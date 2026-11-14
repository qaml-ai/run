package image

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"time"
)

type Config struct {
	StreamIdle, ApplyMax    time.Duration
	Data                    string
	VirtualSize             int64
	MaxFiles                int
	MaxBytes, MaxPathsBytes int64
}
type Manager struct {
	pins map[string]map[string]bool
	Config
	Store   store.Store
	Cache   *cache.Cache
	Refs    refs.Repository
	mu      sync.Mutex
	mounts  map[string]*Mount
	stop    chan struct{}
	sweepMu sync.Mutex
}
type Request struct {
	JobID   string      `json:"jobId"`
	Lineage string      `json:"lineage"`
	Fence   *refs.Fence `json:"fence"`
	Tree    string      `json:"tree"`
	Parent  string      `json:"-"`
}
type Mount struct {
	mu      *sync.Mutex
	streams *streams
	Request
	Root     string `json:"root"`
	Image    string `json:"image"`
	Warm     bool   `json:"warm"`
	State    string `json:"state"`
	Dest     string
	Parent   refs.Value
	Snapshot int
	Promoted bool
}

func New(c Config, s store.Store, cache *cache.Cache, r refs.Repository) (*Manager, error) {
	if c.StreamIdle == 0 {
		c.StreamIdle = 30 * time.Second
	}
	if c.ApplyMax == 0 {
		c.ApplyMax = 30 * time.Minute
	}
	if c.StreamIdle < 0 || c.ApplyMax < 0 {
		return nil, apierr.Invalid("invalid stream deadlines")
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
	if c.VirtualSize == 0 {
		c.VirtualSize = 1 << 30
	}
	if c.MaxFiles == 0 {
		c.MaxFiles = 200000
	}
	if c.MaxBytes == 0 {
		c.MaxBytes = 8 << 30
	}
	if c.MaxPathsBytes == 0 {
		c.MaxPathsBytes = 64 << 20
	}
	if c.VirtualSize < 1 || c.VirtualSize%512 != 0 || c.MaxFiles < 1 || c.MaxBytes < 1 || c.MaxPathsBytes < 1 {
		return nil, apierr.Invalid("invalid size or checkpoint caps")
	}
	if e := blank(c); e != nil {
		return nil, e
	}
	if db, ok := r.(*refs.DB); ok {
		s = &store.Uploaded{Store: s, DB: db.DB}
	}
	m := &Manager{Config: c, Store: s, Cache: cache, Refs: r, mounts: map[string]*Mount{}, stop: make(chan struct{})}
	if err := m.recoverSessions(entries); err != nil {
		return nil, err
	}
	go m.maintain()
	return m, nil
}
func ms(t time.Time) float64 { return float64(time.Since(t).Microseconds()) / 1000 }
func (m *Manager) load(ctx context.Context, lineage, id string) (root.Root, error) {
	b, e := store.ForLineage(m.Store, lineage).Get(ctx, "r/"+id)
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
	return m.Refs.Mount(v.JobID, v.Lineage, "", v.Root, v.Tree, v.Image, v.State, v.Warm, v.Fence.Epoch)
}
func validMountFence(fence *refs.Fence) bool {
	return fence != nil && fence.Holder != "" && fence.Epoch > 0
}

func (m *Manager) Mount(ctx context.Context, q Request) (out *Mount, err error) {
	if !hostwire.MountID.MatchString(q.JobID) || q.JobID == "." || q.JobID == ".." || !store.Lineage(q.Lineage) || !root.Hex(q.Tree, 40) {
		return nil, apierr.Invalid("invalid mount request")
	}
	if !validMountFence(q.Fence) {
		return nil, apierr.Invalid("mount requires a valid fence")
	}
	if !root.Hex(q.Parent, 40) {
		return nil, apierr.Invalid("invalid parent commit")
	}
	m.mu.Lock()
	if _, exists := m.mounts[q.JobID]; exists {
		m.mu.Unlock()
		return nil, apierr.Invalid("job already mounted")
	}
	if m.mounts == nil {
		m.mounts = map[string]*Mount{}
	}
	m.mounts[q.JobID] = nil
	m.mu.Unlock()
	defer func() {
		if err != nil {
			m.mu.Lock()
			delete(m.mounts, q.JobID)
			m.mu.Unlock()
		}
	}()
	ok, e := m.objects(q.Lineage).Reachable(ctx, q.Lineage, q.Tree, "tree")
	if e != nil {
		return nil, e
	}
	if !ok {
		return nil, os.ErrNotExist
	}
	treeRoot, e := m.baseRoot(ctx, q.Lineage, q.Tree)
	if e != nil {
		return nil, e
	}
	v := &Mount{Request: q, Root: treeRoot, mu: new(sync.Mutex)}
	v.Parent = refs.Value{Commit: q.Parent, Tree: q.Tree, Root: v.Root}
	v.Request.Parent = ""
	r, e := m.mountRoot(ctx, v.Lineage, v.Root)
	if e != nil {
		return nil, e
	}
	dir := filepath.Join(m.Data, "mounts", q.JobID)
	if e = os.Mkdir(dir, 0700); e != nil {
		return nil, e
	}
	v.Dest = filepath.Join(dir, "image.img")
	v.Image = v.Dest
	defer func() {
		if err != nil {
			_ = os.RemoveAll(dir)
		}
	}()
	if e = store.Atomic(filepath.Join(dir, "session"), nil); e != nil {
		return nil, e
	}
	m.protect(v.JobID, r, v.Root)
	defer func() {
		if err != nil {
			m.unprotect(v.JobID)
		}
	}()
	base := m.image(v.Root)
	if v.Root == "" {
		base = filepath.Join(m.Data, "images", fmt.Sprintf("blank-%d.img", m.VirtualSize))
	}
	if _, e = os.Stat(base); e == nil {
		store.TouchUsed(base, time.Now())
		e = clone(base, v.Dest)
		v.Warm = true
		v.State = "warm"
	} else if !os.IsNotExist(e) {
		return nil, e
	} else {
		// Complete hydration before handing the disk to Firecracker. A live VM's
		// disk must not depend on an NBD connection owned by this process.
		e = m.materialize(ctx, v.Lineage, r, v.Dest)
		v.State = "hydrated"
	}
	if e != nil {
		return nil, e
	}
	if e = m.save(v); e != nil {
		return nil, e
	}
	m.mu.Lock()
	m.mounts[q.JobID] = v
	m.mu.Unlock()
	copy := *v
	return &copy, nil
}
func (m *Manager) materialize(ctx context.Context, lineage string, r root.Root, p string) error {
	f, e := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	if e = f.Truncate(r.VirtualSize); e != nil {
		return e
	}
	keys := make([]string, 0, len(r.Chunks))
	for key := range r.Chunks {
		keys = append(keys, key)
	}
	e = store.Parallel(store.Background(ctx), 64, keys, func(key string) error {
		p, e := m.Cache.EnsureLineage(store.Background(ctx), lineage, r.Chunks[key])
		if e != nil {
			return e
		}
		b, e := os.ReadFile(p)
		if e != nil {
			return e
		}
		off, _ := strconv.ParseInt(key, 10, 64)
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
	dir, e := os.MkdirTemp(filepath.Dir(dst), "promote-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(dir)
	tmp := filepath.Join(dir, "image.img")
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
func (m *Manager) Release(ctx context.Context, id string) (bool, error) {
	v := m.lookup(id)
	if v == nil {
		return false, os.ErrNotExist
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.State == "released" {
		return false, os.ErrNotExist
	}
	if v.streams != nil {
		v.streams.close()
	}

	if e := os.RemoveAll(filepath.Dir(v.Dest)); e != nil {
		return false, e
	}
	if e := m.Refs.DropMount(id); e != nil {
		return false, e
	}
	m.mu.Lock()
	delete(m.mounts, id)
	m.mu.Unlock()
	m.unprotect(v.JobID)
	v.State = "released"
	return v.Promoted, nil
}

func (m *Manager) Close() {
	close(m.stop)
	m.mu.Lock()
	ids := make([]string, 0, len(m.mounts))
	for id := range m.mounts {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		if v := m.lookup(id); v != nil {
			v.mu.Lock()
			if v.streams != nil {
				v.streams.close()
			}
			v.mu.Unlock()
		}

	}
}

func (m *Manager) lookup(id string) *Mount { m.mu.Lock(); defer m.mu.Unlock(); return m.mounts[id] }
