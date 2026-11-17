package image

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
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
	BaselineDiskMax         int64
	PrebuiltImages          bool         // normal daemon starts; false only for legacy fixtures
	PackedApply             *PackedApply // benchmark fixture only; no runtime flag
	PackedParallel          bool         // benchmark fixture only; no runtime flag
}
type Manager struct {
	pins map[string]map[string]bool
	Config
	Store          store.Store
	Refs           refs.Repository
	mu             sync.Mutex
	mounts         map[string]*Mount
	stop           chan struct{}
	sweepMu        sync.Mutex
	baselineSlot   chan struct{}
	baselineWork   sync.WaitGroup
	baselineCtx    context.Context
	baselineCancel context.CancelFunc
	baselineBytes  int64 // Reserved logical bytes, guarded by mu.
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
	BaseTree      string
	CachedImage   string
	Image         string `json:"image"`
	Warm          bool   `json:"warm"`
	State         string `json:"state"`
	Dest          string
	Parent        refs.Value
	Promoted      bool
	needsBaseline bool
}

func New(c Config, s store.Store, r refs.Repository) (*Manager, error) {
	if c.StreamIdle == 0 {
		c.StreamIdle = 30 * time.Second
	}
	if c.ApplyMax == 0 {
		c.ApplyMax = 30 * time.Minute
	}
	if c.StreamIdle < 0 || c.ApplyMax < 0 {
		return nil, apierr.Invalid("invalid stream deadlines")
	}
	for _, d := range []string{c.Data, imageDir(c.Data), filepath.Join(c.Data, "mounts")} {
		if e := os.MkdirAll(d, 0700); e != nil {
			return nil, e
		}
	}
	if e := Probe(c.Data); e != nil {
		return nil, e
	}
	if os.Getenv("CAMELFSD_TEST_NO_REFLINK") == "1" {
		log.Print("test mode: reflink probe skipped, plain image copies")
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
	if c.PrebuiltImages {
		if e := recoverPrebuiltImages(c.Data); e != nil {
			return nil, e
		}
	} else {
		if e := blank(c); e != nil {
			return nil, e
		}
	}
	if c.BaselineDiskMax < 0 {
		return nil, apierr.Invalid("invalid baseline disk cap")
	}
	if c.BaselineDiskMax == 0 {
		c.BaselineDiskMax = 2 * min(c.VirtualSize, math.MaxInt64/2)
	}
	if db, ok := r.(*refs.DB); ok {
		s = &store.Uploaded{Store: s, DB: db.DB}
	}
	m := &Manager{Config: c, Store: s, Refs: r, mounts: map[string]*Mount{}, stop: make(chan struct{}), baselineSlot: make(chan struct{}, 1)}
	if err := m.recoverBaselines(); err != nil {
		return nil, err
	}
	if err := m.recoverSessions(entries); err != nil {
		return nil, err
	}
	m.baselineCtx, m.baselineCancel = context.WithCancel(context.Background())
	go m.maintain()
	return m, nil
}
func ms(t time.Time) float64              { return float64(time.Since(t).Microseconds()) / 1000 }
func (m *Manager) image(id string) string { return filepath.Join(imageDir(m.Data), id+".img") }
func (m *Manager) save(v *Mount) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	if e = store.Atomic(filepath.Join(filepath.Dir(v.Dest), "state.json"), b); e != nil {
		return e
	}
	return m.Refs.Mount(v.JobID, v.Lineage, "", v.CachedImage, v.Tree, v.Image, v.State, v.Warm, v.Fence.Epoch)
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
	defer m.unprotect(q.JobID)
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
	if m.PrebuiltImages {
		if err := m.validateBootCommit(ctx, q.Lineage, q.Tree, q.Parent); err != nil {
			return nil, err
		}
	}
	baseTree, imageID, e := m.cachedAncestor(ctx, q.Lineage, q.Tree)
	if e != nil {
		return nil, e
	}
	if imageID == "" {
		baseTree, imageID, e = m.cachedCommitAncestor(ctx, q.Lineage, q.Tree, q.Parent)
		if e != nil {
			return nil, e
		}
		if imageID != "" {
			canReuse, err := m.canReuseCommitImage(ctx, q.Lineage, baseTree, q.Tree)
			if err != nil {
				return nil, err
			}
			if !canReuse {
				baseTree, imageID = "", ""
			}
		}
	}
	v := &Mount{Request: q, BaseTree: baseTree, CachedImage: imageID, mu: new(sync.Mutex)}
	v.Parent = refs.Value{Commit: q.Parent, Tree: q.Tree}
	v.Request.Parent = ""
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
	// Eviction may win after lookup and before the cache file is pinned.
	base := blankImage(m.Data, m.VirtualSize)
	if imageID != "" {
		m.protect(v.JobID, imageID)
		cached := m.image(imageID)
		if st, err := os.Stat(cached); err == nil && st.Size() == m.VirtualSize {
			store.TouchUsed(cached, time.Now())
			base, v.Warm = cached, true
		} else {
			v.BaseTree, v.CachedImage = "", ""
		}
	}
	if !v.Warm && m.PrebuiltImages {
		imageID, e = m.preparePrebuiltImage(ctx, q)
		if e != nil {
			return nil, e
		}
		if !root.Hex(imageID, 64) {
			return nil, fmt.Errorf("invalid prebuilt image ID")
		}
		cached := m.image(imageID)
		st, err := os.Stat(cached)
		if err != nil {
			return nil, err
		}
		if !st.Mode().IsRegular() || st.Size() != m.VirtualSize {
			return nil, fmt.Errorf("invalid prebuilt image file")
		}
		store.TouchUsed(cached, time.Now())
		base, v.BaseTree, v.CachedImage, v.Warm = cached, q.Tree, imageID, true
	}
	if e = clone(base, v.Dest); e != nil {
		return nil, e
	}
	v.State = "blank"
	if v.Warm {
		v.State = "warm"
	}
	v.needsBaseline = v.BaseTree != v.Tree
	if e = m.save(v); e != nil {
		return nil, e
	}
	m.mu.Lock()
	m.mounts[q.JobID] = v
	m.mu.Unlock()
	copy := *v
	return &copy, nil
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
	m.StopBaselines()
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
	m.baselineWork.Wait()
}

func (m *Manager) lookup(id string) *Mount { m.mu.Lock(); defer m.mu.Unlock(); return m.mounts[id] }
