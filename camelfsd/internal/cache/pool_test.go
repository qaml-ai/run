package cache

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type poolStore struct {
	active, peak atomic.Int32
	entered      chan struct{}
	gate         chan struct{}
}

func (s *poolStore) Get(ctx context.Context, k string) ([]byte, error) {
	n := s.active.Add(1)
	defer s.active.Add(-1)
	for p := s.peak.Load(); n > p; p = s.peak.Load() {
		if s.peak.CompareAndSwap(p, n) {
			break
		}
	}
	s.entered <- struct{}{}
	select {
	case <-s.gate:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return make([]byte, root.ChunkSize), nil
}
func (*poolStore) Put(context.Context, string, []byte) error        { return nil }
func (*poolStore) Has(context.Context, string) (bool, error)        { return false, nil }
func (*poolStore) Head(context.Context, string) (store.Info, error) { return store.Info{}, nil }
func TestMountsShareHostPoolAndReserve(t *testing.T) {
	s := &poolStore{entered: make(chan struct{}, 100), gate: make(chan struct{})}
	host := store.WithDepth(s, 4)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	// Separate cache clients simulate mounts; the daemon also shares one cache.
	for i := 0; i < 3; i++ {
		c := New(t.TempDir(), store.ForLineage(host, fmt.Sprint("l", i)), 64)
		for j := 0; j < 8; j++ {
			wg.Add(1)
			go func(j int) { defer wg.Done(); _, _ = c.EnsureContext(store.Background(ctx), fmt.Sprintf("%064x", j+1)) }(j)
		}
	}
	for i := 0; i < 3; i++ {
		select {
		case <-s.entered:
		case <-ctx.Done():
			t.Fatal("background pool stalled")
		}
	}
	select {
	case <-s.entered:
		t.Fatal("background consumed reserve")
	case <-time.After(30 * time.Millisecond):
	}
	wg.Add(1)
	go func() { defer wg.Done(); _, _ = host.Get(ctx, "demand") }()
	select {
	case <-s.entered:
	case <-ctx.Done():
		t.Fatal("demand reserve unavailable")
	}
	if s.peak.Load() != 4 {
		t.Fatal(s.peak.Load())
	}
	close(s.gate)
	wg.Wait()
	if s.peak.Load() > 4 {
		t.Fatal("exceeded host depth", s.peak.Load())
	}
}
