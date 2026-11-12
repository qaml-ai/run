package cache

import (
	"context"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type flight struct {
	done chan struct{}
	path string
	err  error
}
type Cache struct {
	Dir     string
	Store   store.Store
	mu      sync.Mutex
	flights map[string]*flight
	slots   chan struct{}
}

func New(dir string, s store.Store, n int) *Cache {
	if n < 1 {
		n = 64
	}
	return &Cache{Dir: dir, Store: s, flights: map[string]*flight{}, slots: make(chan struct{}, n)}
}
func (c *Cache) Ensure(h string) (string, error) { return c.EnsureContext(context.Background(), h) }
func (c *Cache) EnsureContext(ctx context.Context, h string) (string, error) {
	if !root.Hex(h, 64) {
		return "", fmt.Errorf("invalid hash")
	}
	p := filepath.Join(c.Dir, h[:2], h)
	c.mu.Lock()
	if f := c.flights[h]; f != nil {
		c.mu.Unlock()
		select {
		case <-f.done:
			return f.path, f.err
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	f := &flight{done: make(chan struct{})}
	c.flights[h] = f
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.flights, h); close(f.done); c.mu.Unlock() }()
	if b, e := os.ReadFile(p); e == nil && root.Hash(b) == h && len(b) == int(root.ChunkSize) {
		_ = os.Chtimes(p, time.Now(), time.Now())
		f.path = p
		return p, nil
	}
	select {
	case c.slots <- struct{}{}:
	case <-ctx.Done():
		f.err = ctx.Err()
		return "", f.err
	}
	defer func() { <-c.slots }()
	b, e := c.Store.Get(ctx, "c/"+h)
	if e == nil && (root.Hash(b) != h || len(b) != int(root.ChunkSize)) {
		e = fmt.Errorf("chunk hash mismatch")
	}
	if e == nil {
		e = store.Atomic(p, b)
	}
	f.err = e
	if e == nil {
		f.path = p
	}
	return f.path, e
}
func (c *Cache) Fetch(ctx context.Context, hashes []string, n int) error {
	return store.Parallel(ctx, n, hashes, func(h string) error { _, e := c.EnsureContext(ctx, h); return e })
}
