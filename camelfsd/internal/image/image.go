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

	"time"
)

var JobID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)
var ErrNoRoot = errors.New("no-root-for-tree")

type Config struct {
	StreamIdle, ApplyMax          time.Duration
	Now                           func() time.Time
	Origin                        *nbd.Server
	HydrationPackSize             int64
	Data, Cold, NBDListen, HostID string
	ImportAllow                   []string
	VirtualSize                   int64
	MaxFiles                      int
	MaxBytes, MaxPathsBytes       int64
}
type Manager struct {
	pins map[string]map[string]bool
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
	JobID   string      `json:"jobId"`
	Lineage string      `json:"lineage"`
	Fence   *refs.Fence `json:"fence"`
	Root    string      `json:"root"`
	Tree    string      `json:"tree"`
	Hydrate bool        `json:"hydrate"`
	Vsock   string      `json:"vsock"`
}
type Mount struct {
	NBDListen string `json:"nbdListen"`
	mu        *sync.Mutex
	streams   *streams
	Apply     *Apply  `json:"apply"`
	Applied   bool    `json:"applied"`
	ApplyMs   float64 `json:"applyMs"`
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
	Snapshot                          int
	Promoted                          bool
	stopPoll                          chan struct{}
	releaseOrigin                     func()
	hydrated                          string
	hydrationRoot                     string
	early                             *earlyResult
	earlyCancel                       context.CancelFunc
	earlyConsumed                     bool
	pendingRanges                     []chunk.Range
}

// Hydration defaults on for JSON callers while retaining the Go bool API.
func (q *Request) UnmarshalJSON(b []byte) error {
	type plain Request
	v := plain{Hydrate: true}
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.DisallowUnknownFields()
	if e := decoder.Decode(&v); e != nil {
		return e
	}
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
	if c.Cold != "clone" && c.Cold != "prehydrate" {
		return nil, apierr.Invalid("invalid cold mode")
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
	if c.HydrationPackSize == 0 {
		c.HydrationPackSize = 4 << 20
	}
	if c.HydrationPackSize < chunk.Size || c.HydrationPackSize%chunk.Size != 0 {
		return nil, apierr.Invalid("invalid hydration pack size")
	}
	if db, ok := r.(*refs.DB); ok {
		s = &store.Uploaded{Store: s, DB: db.DB}
	}
	m := &Manager{Config: c, Store: s, Cache: cache, Refs: r, mounts: map[string]*Mount{}, stop: make(chan struct{})}
	go m.maintain()
	return m, nil
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
	if forms != 1 || !JobID.MatchString(q.JobID) || q.JobID == "." || q.JobID == ".." || q.Lineage == "" || q.Root != "" && !root.Hex(q.Root, 64) || q.Tree != "" && !root.Hex(q.Tree, 40) {
		return nil, apierr.Invalid("invalid mount request")
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
	if q.Fence != nil && (q.Fence.Holder == "" || q.Fence.Epoch < 0) {
		return nil, apierr.Invalid("invalid fence")
	}
	var treeRoot string
	if q.Tree != "" {
		ok, e := m.objects().Reachable(ctx, q.Lineage, q.Tree, "tree")
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
	v.Parent = refs.Value{Tree: q.Tree, Root: v.Root}
	r, e := m.mountRoot(ctx, v.Root)
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
	} else if m.Cold == "prehydrate" {
		if e = m.sweep(r.VirtualSize); e != nil {
			return nil, e
		}
		e = m.materialize(ctx, r, v.Dest)
		v.Warm = true
		v.State = "warm"
		if e == nil {
			e = m.promote(v.Dest, v.Root)
		}
	} else {
		if e = m.sweep(r.VirtualSize); e != nil {
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
		v.stopPoll = make(chan struct{})
		go m.poll(v, v.stopPoll)
	}
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
	windows := packWindows(r, m.HydrationPackSize)
	keys := make([]string, len(windows))
	for i := range keys {
		keys[i] = strconv.Itoa(i)
	}
	e = store.Parallel(ctx, 32, keys, func(key string) error {
		i, _ := strconv.Atoi(key)
		for _, o := range windows[i] {
			p, e := m.Cache.EnsureContext(ctx, r.Chunks[o])
			if e != nil {
				return e
			}
			b, e := os.ReadFile(p)
			if e != nil {
				return e
			}
			off, _ := strconv.ParseInt(o, 10, 64)
			if _, e = f.WriteAt(b[:min(int64(len(b)), r.VirtualSize-off)], off); e != nil {
				return e
			}
		}
		return nil
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
	if _, e = run(ctx, "nbd-client", "-N", v.Root, host, port, v.NBD, "-C", "4"); e != nil {
		v.NBD = ""
		return e
	}
	if e = m.save(v); e != nil {
		return e
	}
	v.DestLoop, e = run(ctx, "losetup", "-f", "--show", v.Dest)
	if e != nil {
		return e
	}
	if e = m.save(v); e != nil {
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
	if e = m.save(v); e != nil {
		return e
	}
	dm := DMPrefix(m.Data) + v.JobID
	table := fmt.Sprintf("0 %d clone %s %s %s 512 1 no_hydration", r.VirtualSize/512, v.MetaLoop, v.DestLoop, v.NBD)
	if _, e = run(ctx, "dmsetup", "create", dm, "--table", table); e != nil {
		return e
	}
	v.DM = dm
	if e = m.save(v); e != nil {
		return e
	}
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
	if v.DM == "" || v.State == "hydrated" || v.State == "released" {
		return nil
	}
	s, e := run(ctx, "dmsetup", "status", v.DM)
	if e != nil {
		return e
	}
	fields := strings.Fields(s)
	if len(fields) < 7 {
		return apierr.Invalid("invalid clone status: %s", s)
	}
	a, b, ok := strings.Cut(fields[6], "/")
	if !ok {
		return apierr.Invalid("invalid hydration status")
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
		if e = m.hydratedSnapshot(ctx, v); e != nil {
			return e
		}
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

	if v.early != nil {
		select {
		case <-v.early.done:
			if v.early.err == nil && v.early.clean {
				if e := m.promote(v.hydrated, v.hydrationRoot); e != nil {
					return false, e
				}
				v.Promoted = true
			}
		default:
		}
		v.earlyCancel()
		<-v.early.done
	}

	if e := m.cleanup(v); e != nil {
		return false, e
	}
	if v.stopPoll != nil {
		close(v.stopPoll)
		v.stopPoll = nil
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
		if _, e := m.Release(context.Background(), id); e != nil {
			log.Printf("op=cleanup jobId=%s error=%v", id, e)
		}
	}
}

func (m *Manager) lookup(id string) *Mount { m.mu.Lock(); defer m.mu.Unlock(); return m.mounts[id] }
