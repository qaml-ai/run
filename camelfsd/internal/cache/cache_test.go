package cache

import (
	"context"
	"encoding/binary"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type counted struct {
	n    atomic.Int32
	b    []byte
	gate chan struct{}
}

func (c *counted) Get(context.Context, string) ([]byte, error) { c.n.Add(1); <-c.gate; return c.b, nil }
func (c *counted) Put(context.Context, string, []byte) error   { return nil }
func (c *counted) Has(context.Context, string) (bool, error)   { return false, nil }
func TestSingleFlight(t *testing.T) {
	s := &counted{b: make([]byte, root.ChunkSize), gate: make(chan struct{})}
	s.b[0] = 1
	c := New(t.TempDir(), s, 4)
	h := root.Hash(s.b)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := c.Ensure(h); e != nil {
				t.Error(e)
			}
		}()
	}
	close(s.gate)
	wg.Wait()
	if s.n.Load() != 1 {
		t.Fatal(s.n.Load())
	}
}
func TestCorruption(t *testing.T) {
	s := &counted{b: make([]byte, root.ChunkSize), gate: make(chan struct{})}
	close(s.gate)
	c := New(t.TempDir(), s, 4)
	if _, e := c.Ensure(root.Hash([]byte("wrong"))); e == nil {
		t.Fatal("accepted corrupt chunk")
	}
}

func TestDiskCorruptionAndTrustedHits(t *testing.T) {
	s := &counted{b: make([]byte, root.ChunkSize), gate: make(chan struct{})}
	s.b[0] = 1
	close(s.gate)
	c := New(t.TempDir(), s, 4)
	defer c.Close()
	h := root.Hash(s.b)
	p := filepath.Join(c.Dir, h[:2], h)
	os.MkdirAll(filepath.Dir(p), 0700)
	os.WriteFile(p, make([]byte, root.ChunkSize), 0600)
	got, e := c.Ensure(h)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(got)
	if root.Hash(b) != h {
		t.Fatal("served corrupt cache")
	}
	count := c.Hashes.Load()
	for i := 0; i < 100; i++ {
		if _, e = c.Ensure(h); e != nil {
			t.Fatal(e)
		}
	}
	if c.Hashes.Load() != count {
		t.Fatal("warm hits rehashed")
	}
	if e = c.Remove(p); e != nil {
		t.Fatal(e)
	}
	if _, e = c.Ensure(h); e != nil {
		t.Fatal("eviction left a stale verified hit", e)
	}
}
func TestDescriptorLRUBounded(t *testing.T) {
	s := store.Local{Dir: t.TempDir()}
	c := New(t.TempDir(), s, 4)
	defer c.Close()
	for i := 0; i < openLimit+5; i++ {
		b := make([]byte, root.ChunkSize)
		binary.BigEndian.PutUint64(b, uint64(i+1))
		h := root.Hash(b)
		if e := s.Put(context.Background(), "c/"+h, b); e != nil {
			t.Fatal(e)
		}
		if e := c.ReadAt(h, make([]byte, 4096), 0); e != nil {
			t.Fatal(e)
		}
	}
	if len(c.fds) != openLimit {
		t.Fatal(len(c.fds))
	}
}

// A background flight waiting for network capacity must not pin a demand read.
func TestDemandDisplacesQueuedBackground(t *testing.T) {
	ctx := context.Background()
	local := store.Local{Dir: t.TempDir()}
	b := make([]byte, root.ChunkSize)
	b[0] = 42
	h := root.Hash(b)
	if e := local.Put(ctx, "c/"+h, b); e != nil {
		t.Fatal(e)
	}
	// Hold the only background slot with an unrelated GET.
	s := &priorityStore{Store: local, started: make(chan struct{}), gate: make(chan struct{})}
	c := New(t.TempDir(), s, 2)
	defer c.Close()
	defer close(s.gate)
	go c.EnsureContext(store.Background(ctx), root.Hash([]byte("blocked")))
	<-s.started
	done := make(chan error, 1)
	go func() { _, e := c.Ensure(h); done <- e }()
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("demand waited behind background")
	}
}

type priorityStore struct {
	store.Store
	started chan struct{}
	gate    chan struct{}
	once    sync.Once
}

func (s *priorityStore) Get(ctx context.Context, k string) ([]byte, error) {
	if k == "c/"+root.Hash([]byte("blocked")) {
		s.once.Do(func() { close(s.started) })
		select {
		case <-s.gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return s.Store.Get(ctx, k)
}

func TestDemandPromotesSameQueuedChunk(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	local := store.Local{Dir: t.TempDir()}
	b := make([]byte, root.ChunkSize)
	b[0] = 81
	h := root.Hash(b)
	if e := local.Put(ctx, "c/"+h, b); e != nil {
		t.Fatal(e)
	}
	s := &queuedStore{Store: local, target: "c/" + h, started: make(chan struct{}, 64)}
	c := New(t.TempDir(), s, 64)
	var wg sync.WaitGroup
	defer func() { cancel(); wg.Wait(); c.Close() }()
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _ = c.EnsureContext(store.Background(ctx), root.Hash([]byte{byte(i)}))
		}(i)
	}
	for i := 0; i < 64; i++ {
		select {
		case <-s.started:
		case <-time.After(time.Second):
			t.Fatal("background pool did not fill")
		}
	}
	wg.Add(1)
	go func() { defer wg.Done(); _, _ = c.EnsureContext(store.Background(ctx), h) }()
	deadline := time.Now().Add(time.Second)
	for {
		c.mu.Lock()
		queued := c.flights[h] != nil
		c.mu.Unlock()
		if queued {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background target not queued")
		}
		time.Sleep(time.Millisecond)
	}
	demand, stop := context.WithTimeout(ctx, time.Second)
	defer stop()
	if _, e := c.EnsureContext(demand, h); e != nil {
		t.Fatal("queued target did not jump background", e)
	}
}

type queuedStore struct {
	store.Store
	target  string
	started chan struct{}
}

func (s *queuedStore) Get(ctx context.Context, k string) ([]byte, error) {
	if k != s.target {
		select {
		case s.started <- struct{}{}:
		default:
		}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return s.Store.Get(ctx, k)
}
