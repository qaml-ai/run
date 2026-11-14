package cache

import (
	"context"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
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
	c := New(t.TempDir(), store.ForLineage(s, "l"), 4)
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
	c := New(t.TempDir(), store.ForLineage(s, "l"), 4)
	if _, e := c.Ensure(root.Hash([]byte("wrong"))); e == nil {
		t.Fatal("accepted corrupt chunk")
	}
}

func TestDiskCorruptionAndTrustedHits(t *testing.T) {
	s := &counted{b: make([]byte, root.ChunkSize), gate: make(chan struct{})}
	s.b[0] = 1
	close(s.gate)
	c := New(t.TempDir(), store.ForLineage(s, "l"), 4)
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
func (c *counted) Head(context.Context, string) (store.Info, error) { return store.Info{}, nil }
