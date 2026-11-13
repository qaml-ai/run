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
func TestReadAtRefetchesMissingVerifiedFile(t *testing.T) {
	s := &counted{b: make([]byte, root.ChunkSize), gate: make(chan struct{})}
	s.b[0] = 39
	close(s.gate)
	c := New(t.TempDir(), s, 4)
	defer c.Close()
	h := root.Hash(s.b)
	p, e := c.Ensure(h)
	if e != nil {
		t.Fatal(e)
	}
	// Model deletion outside the coordinated eviction path.
	if e = os.Remove(p); e != nil {
		t.Fatal(e)
	}
	got := make([]byte, 4096)
	if e = c.ReadAt(h, got, 0); e != nil {
		t.Fatal("missing verified path was not refetched", e)
	}
	if got[0] != 39 || s.n.Load() != 2 {
		t.Fatal("wrong data or refetch count", got[0], s.n.Load())
	}
	if e = c.ReadAt(h, got, 0); e != nil || s.n.Load() != 2 {
		t.Fatal("recovered hit fetched again", e, s.n.Load())
	}
}
