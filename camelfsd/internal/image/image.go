package image

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/nbd"
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
	"sync/atomic"

	"time"
)

var JobID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)
var ErrNoRoot = errors.New("no-root-for-tree")

// TEMPORARY: removed with jobhost phase 2
var legacyMounts atomic.Uint64

// TEMPORARY: removed with jobhost phase 2
func LegacyMounts() uint64 { return legacyMounts.Load() }

type Config struct {
	RecoverSessions         bool
	StreamIdle, ApplyMax    time.Duration
	Now                     func() time.Time
	Origin                  *nbd.Server
	CowMax                  int64
	Data, NBDListen, HostID string
	ImportAllow             []string
	VirtualSize             int64
	MaxFiles                int
	MaxBytes, MaxPathsBytes int64
}
type Manager struct {
	pins            map[string]map[string]bool
	PrehydrateBytes atomic.Int64
	Config
	Store    store.Store
	Cache    *cache.Cache
	Refs     refs.Repository
	deviceMu sync.Mutex // Serializes free NBD selection and attachment.
	mu       sync.Mutex
	mounts   map[string]*Mount
	stop     chan struct{}
	sweepMu  sync.Mutex
}
type Request struct {
	// TEMPORARY: removed with jobhost phase 2
	legacyFence bool
	JobID       string      `json:"jobId"`
	Lineage     string      `json:"lineage"`
	Fence       *refs.Fence `json:"fence"`
	Root        string      `json:"root"`
	Tree        string      `json:"tree"`
	Parent      string      `json:"parent,omitempty"`
	Session     bool        `json:"-"`
	Hydrate     bool        `json:"hydrate"`
	Vsock       string      `json:"vsock"`
}
type Mount struct {
	NBDListen string `json:"nbdListen"`
	mu        *sync.Mutex
	streams   *streams
	Apply     *Apply  `json:"apply"`
	Applied   bool    `json:"applied"`
	ApplyMs   float64 `json:"applyMs"`
	Request
	Image                                      string  `json:"image"`
	Warm                                       bool    `json:"warm"`
	State                                      string  `json:"state"`
	LeaseEpoch                                 int64   `json:"leaseEpoch"`
	MountMs                                    float64 `json:"mountMs"`
	Hydrating                                  bool    `json:"hydrating"`
	Dest, CowLoop, DestLoop, NBD, DM, OriginDM string
	Parent                                     refs.Value
	Snapshot                                   int
	Promoted                                   bool
	releaseOrigin                              func()
	hydrationRoot                              string
	hydration                                  *hydration
	HydrationMBps                              float64 `json:"hydrationMBps"`
	HydratedBytes                              int64   `json:"hydratedBytes"`
	TotalBytes                                 int64   `json:"totalBytes"`
	SwapMs                                     float64 `json:"swapMs"`
	HydrationError                             string  `json:"hydrationError,omitempty"`
	preparedSnapshot                           string
	preparedRanges                             []chunk.Range
	pendingRanges                              []chunk.Range
}

// Hydration defaults on for JSON callers. Only an absent JSON fence enables
// phase-1 compatibility; explicit null (and a nil Go fence) remain read-only.
func (q *Request) UnmarshalJSON(b []byte) error {
	type plain Request
	v := plain{Hydrate: true}
	body := struct {
		*plain
		Parent json.RawMessage `json:"parent"`
	}{plain: &v}
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.DisallowUnknownFields()
	if e := decoder.Decode(&body); e != nil {
		return e
	}
	if body.Parent != nil {
		if e := json.Unmarshal(body.Parent, &v.Parent); e != nil || !root.Hex(v.Parent, 40) {
			return &apierr.Error{Status: 400, Code: "invalid_request", Cause: fmt.Errorf("invalid parent commit")}
		}
	}
	// TEMPORARY: removed with jobhost phase 2
	var fields struct{ Fence json.RawMessage }
	if e := json.Unmarshal(b, &fields); e != nil {
		return e
	}
	v.legacyFence = fields.Fence == nil
	*q = Request(v)
	return nil
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
	if c.Now == nil {
		c.Now = time.Now
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
	if len(entries) > 0 && !c.RecoverSessions {
		return nil, fmt.Errorf("existing mount state requires cleanup before restart")
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
	if c.CowMax < 0 || c.CowMax%512 != 0 {
		return nil, apierr.Invalid("invalid cow-max")
	}
	if db, ok := r.(*refs.DB); ok {
		s = &store.Uploaded{Store: s, DB: db.DB}
	}
	m := &Manager{Config: c, Store: s, Cache: cache, Refs: r, mounts: map[string]*Mount{}, stop: make(chan struct{})}
	if c.RecoverSessions {
		if err := m.recoverSessions(entries); err != nil {
			return nil, err
		}
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
	if v.Session {
		if e := store.Atomic(filepath.Join(filepath.Dir(v.Dest), "session"), nil); e != nil {
			return e
		}
	}
	if e = store.Atomic(filepath.Join(filepath.Dir(v.Dest), "state.json"), b); e != nil {
		return e
	}
	return m.Refs.Mount(v.JobID, v.Lineage, "", v.Root, v.Tree, v.Image, v.State, v.Warm, v.LeaseEpoch)
}
func (m *Manager) Mount(ctx context.Context, q Request) (out *Mount, err error) {
	t := time.Now()
	forms := 0
	for _, v := range []string{q.Root, q.Tree} {
		if v != "" {
			forms++
		}
	}
	if forms != 1 || !(JobID.MatchString(q.JobID) || q.Session && hostwire.MountID.MatchString(q.JobID)) || q.JobID == "." || q.JobID == ".." || !store.Lineage(q.Lineage) || q.Root != "" && !root.Hex(q.Root, 64) || q.Tree != "" && !root.Hex(q.Tree, 40) {
		return nil, apierr.Invalid("invalid mount request")
	}
	if q.Fence != nil && q.Parent == "" {
		return nil, &apierr.Error{Status: 400, Code: "invalid_request", Cause: fmt.Errorf("missing field parent")}
	}
	if q.Parent != "" && !root.Hex(q.Parent, 40) {
		return nil, &apierr.Error{Status: 400, Code: "invalid_request", Cause: fmt.Errorf("invalid parent commit")}
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
	// TEMPORARY: removed with jobhost phase 2
	if q.legacyFence {
		q.Fence = &refs.Fence{Holder: m.HostID + "/" + q.JobID, Epoch: 0}
	}
	if q.Fence != nil && (q.Fence.Holder == "" || q.Fence.Epoch < 0) {
		return nil, apierr.Invalid("invalid fence")
	}
	if q.Root != "" {
		ok, e := m.objects(q.Lineage).Reachable(ctx, q.Lineage, q.Root, "root")
		if e != nil {
			return nil, e
		}
		if !ok {
			return nil, os.ErrNotExist
		}
	}
	var treeRoot string
	if q.Tree != "" {
		ok, e := m.objects(q.Lineage).Reachable(ctx, q.Lineage, q.Tree, "tree")
		if e != nil {
			return nil, e
		}
		if !ok {
			return nil, os.ErrNotExist
		}
		id, e := m.baseRoot(ctx, q.Lineage, q.Tree)
		if e != nil {
			return nil, e
		}
		treeRoot = id
	}
	v := &Mount{NBDListen: m.NBDListen, Request: q, mu: new(sync.Mutex)}
	v.mu.Lock()
	defer v.mu.Unlock()
	if q.Tree != "" {
		v.Root = treeRoot
	}
	v.Parent = refs.Value{Commit: q.Parent, Tree: q.Tree, Root: v.Root}
	v.Request.Parent = ""
	r, e := m.mountRoot(ctx, v.Lineage, v.Root)
	if e != nil {
		return nil, e
	}
	v.Tree = r.Tree
	if q.Tree != "" {
		v.Tree = q.Tree
	}

	dir := filepath.Join(m.Data, "mounts", q.JobID)
	if e = os.Mkdir(dir, 0700); e != nil {
		return nil, e
	}
	v.Dest = filepath.Join(dir, "image.img")
	v.Image = v.Dest
	defer func() {
		if err != nil {
			if v.streams != nil {
				v.streams.close()
			}
			_ = m.cleanup(v)
			if v.releaseOrigin != nil {
				v.releaseOrigin()
			}
			_ = os.RemoveAll(dir)
		}
	}()
	if q.Session {
		if e = store.Atomic(filepath.Join(dir, "session"), nil); e != nil {
			return nil, e
		}
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
	} else if q.Session {
		// Complete hydration before handing the disk to Firecracker. A live VM's
		// disk must not depend on an NBD connection owned by this process.
		e = m.materialize(ctx, v.Lineage, r, v.Dest)
		v.State = "hydrated"
	} else {
		if e = m.sweep(int64(len(r.Chunks)) * chunk.Size); e != nil {
			return nil, e
		}
		if e = m.prefetchMount(ctx, v.Lineage, r); e != nil {
			return nil, e
		}
		if m.Origin != nil {
			v.releaseOrigin = m.Origin.Register(v.Root, v.Lineage, r)
		}
		e = m.cold(ctx, v, r)
	}
	if e != nil {
		return nil, e
	}
	if v.Fence == nil {
		if v.DM != "" {
			_, e = run(ctx, "blockdev", "--setro", v.Image)
		} else {
			e = os.Chmod(v.Image, 0400)
		}
		if e != nil {
			return nil, e
		}
	}
	if e = m.startStreams(ctx, v, r.Tree); e != nil {
		return nil, e
	}
	v.MountMs = ms(t)
	if e = m.save(v); e != nil {
		return nil, e
	}
	m.mu.Lock()
	m.mounts[q.JobID] = v
	m.mu.Unlock()
	if v.DM != "" {
		m.startHydration(v, r)
	}
	// TEMPORARY: removed with jobhost phase 2
	if q.legacyFence {
		log.Printf("op=mount legacy-fence jobId=%s count=%d", q.JobID, legacyMounts.Add(1))
	}
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
func (m *Manager) cold(ctx context.Context, v *Mount, r root.Root) error {
	m.deviceMu.Lock()
	defer m.deviceMu.Unlock()
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
	if _, e = run(ctx, "nbd-client", "-N", v.Lineage+"/"+v.Root, host, port, v.NBD, "-C", "4"); e != nil {
		v.NBD = ""
		return e
	}
	if e = m.save(v); e != nil {
		return e
	}
	v.OriginDM = DMPrefix(m.Data) + v.JobID + "-o"
	if e = m.save(v); e != nil {
		return e
	}
	if _, e = run(ctx, "dmsetup", "create", v.OriginDM, "--table", fmt.Sprintf("0 %d linear %s 0", r.VirtualSize/512, v.NBD)); e != nil {
		v.OriginDM = ""
		return e
	}
	cow := filepath.Join(filepath.Dir(v.Dest), "cow.img")
	f, e = os.OpenFile(cow, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	size := m.CowMax
	if size == 0 {
		size = r.VirtualSize
	}
	e = f.Truncate(size)
	f.Close()
	if e != nil {
		return e
	}
	v.CowLoop, e = run(ctx, "losetup", "-f", "--show", cow)
	if e != nil {
		return e
	}
	if e = m.save(v); e != nil {
		return e
	}
	v.DM = DMPrefix(m.Data) + v.JobID
	if e = m.save(v); e != nil {
		return e
	}
	table := fmt.Sprintf("0 %d snapshot /dev/mapper/%s %s P 1024", r.VirtualSize/512, v.OriginDM, v.CowLoop)
	if _, e = run(ctx, "dmsetup", "create", v.DM, "--table", table); e != nil {
		v.DM = ""
		return e
	}
	v.Image = "/dev/mapper/" + v.DM
	v.State = "cold"
	v.Hydrating = true
	v.hydrationRoot = v.Root
	for key := range r.Chunks {
		off, _ := strconv.ParseInt(key, 10, 64)
		v.TotalBytes += min(chunk.Size, r.VirtualSize-off)
	}
	return nil
}
func (m *Manager) status(ctx context.Context, v *Mount) error {
	if v.hydration == nil {
		return nil
	}
	v.HydratedBytes = v.hydration.bytes.Load()
	v.HydrationMBps = v.hydration.mbps()
	select {
	case <-v.hydration.done:
		if v.hydration.err != nil {
			v.HydrationError = v.hydration.err.Error()
			v.Hydrating = false
			return v.hydration.err
		}
		if v.State != "hydrated" {
			return m.swap(ctx, v)
		}
	default:
		v.State = "hydrating"
	}
	return nil
}

func (m *Manager) Status(ctx context.Context, id string) (*Mount, error) {
	v := m.lookup(id)
	if v == nil {
		return nil, os.ErrNotExist
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.State == "released" {
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
	if v.OriginDM != "" {
		if _, e := run(ctx, "dmsetup", "remove", v.OriginDM); e != nil {
			return e
		}
		v.OriginDM = ""
	}
	for _, p := range []*string{&v.CowLoop, &v.DestLoop} {
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

	if v.hydration != nil {
		v.hydration.cancel()
		<-v.hydration.done
		if v.hydration.err == nil {
			if e := m.promote(v.Dest, v.hydrationRoot); e != nil {
				return false, e
			}
			v.Promoted = true
		}
	}
	if e := m.cleanup(v); e != nil {
		return false, e
	}
	if v.releaseOrigin != nil {
		v.releaseOrigin()
		v.releaseOrigin = nil
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
	defer m.Cache.Close()
	close(m.stop)
	m.mu.Lock()
	ids := make([]string, 0, len(m.mounts))
	for id := range m.mounts {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		if v := m.lookup(id); v != nil && v.Session {
			v.mu.Lock()
			if v.streams != nil {
				v.streams.close()
			}
			v.mu.Unlock()
			continue
		}
		if _, e := m.Release(context.Background(), id); e != nil {
			log.Printf("op=cleanup jobId=%s error=%v", id, e)
		}
	}
}

func (m *Manager) lookup(id string) *Mount { m.mu.Lock(); defer m.mu.Unlock(); return m.mounts[id] }
