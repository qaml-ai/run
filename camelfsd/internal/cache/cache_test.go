package cache

import (
	"context"
	"github.com/qaml-ai/run/camelfsd/internal/root"
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
