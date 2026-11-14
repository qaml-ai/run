package cache

import (
	"context"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

type flight struct {
	done chan struct{}
	path string
	err  error
}
type Cache struct {
	verified map[string]time.Time
	Hashes   atomic.Int64
	Dir      string
	Store    store.Store
	mu       sync.Mutex
	flights  map[string]*flight
	atomic   func(string, []byte) error
}

func New(dir string, s store.Store, n int) *Cache {
	if n < 1 {
		n = 64
	}
	return &Cache{atomic: store.Atomic, Dir: dir, Store: store.WithDepth(s, n), flights: map[string]*flight{}, verified: map[string]time.Time{}}
}
func (c *Cache) Ensure(h string) (string, error) { return c.EnsureContext(context.Background(), h) }
func (c *Cache) EnsureContext(ctx context.Context, h string) (string, error) {
	return c.ensure(ctx, h, c.Store)
}
func (c *Cache) EnsureLineage(ctx context.Context, lineage, h string) (string, error) {
	return c.ensure(ctx, h, store.ForLineage(c.Store, lineage))
}
func (c *Cache) ensure(ctx context.Context, h string, source store.Store) (string, error) {
	if !root.Hex(h, 64) {
		return "", fmt.Errorf("invalid hash")
	}
	p := filepath.Join(c.Dir, h[:2], h)
	c.mu.Lock()
	if last, ok := c.verified[h]; ok {
		now := time.Now()
		if now.Sub(last) >= time.Minute {
			_ = os.Chtimes(p, now, now)
			c.verified[h] = now
		}
		c.mu.Unlock()
		return p, nil
	}
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
	if info, e := os.Stat(p); e == nil && info.Size() == root.ChunkSize {
		b, e := os.ReadFile(p)
		if e == nil && c.hash(b) == h {
			store.TouchUsed(p, time.Now())
			c.mu.Lock()
			c.verified[h] = time.Now()
			c.mu.Unlock()
			f.path = p
			return p, nil
		}
	}
	b, e := source.Get(ctx, "c/"+h)
	if e == nil && (c.hash(b) != h || len(b) != int(root.ChunkSize)) {
		e = fmt.Errorf("chunk hash mismatch")
	}
	if e == nil {
		e = c.atomic(p, b)
	}
	f.err = e
	if e == nil {
		f.path = p
		c.mu.Lock()
		c.verified[h] = time.Now()
		c.mu.Unlock()
	}
	if e != nil && e != context.Canceled {
		return "", fmt.Errorf("fetch chunk %s: %w", h, e)
	}
	return f.path, e
}

// Remove invalidates a trusted hit before eviction.
func (c *Cache) Remove(path string) error {
	h := filepath.Base(path)
	c.mu.Lock()
	if flight := c.flights[h]; flight != nil {
		c.mu.Unlock()
		<-flight.done
		return c.Remove(path)
	}
	defer c.mu.Unlock()
	delete(c.verified, h)
	return os.Remove(path)
}

func (c *Cache) hash(b []byte) string { c.Hashes.Add(1); return root.Hash(b) }
