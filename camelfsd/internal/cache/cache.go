package cache

import (
	"container/list"
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
	done    chan struct{}
	path    string
	err     error
	cancel  context.CancelFunc
	started bool
	pack    bool
}
type Cache struct {
	verified                    map[string]time.Time
	Hashes                      atomic.Int64
	Fetches, Bytes, Packs, Hits atomic.Int64
	fdMu                        sync.Mutex
	fds                         map[string]*list.Element
	lru                         list.List
	Dir                         string
	Store                       store.Store
	mu                          sync.Mutex
	flights                     map[string]*flight
}

func New(dir string, s store.Store, n int) *Cache {
	if n < 1 {
		n = 64
	}
	return &Cache{Dir: dir, Store: store.WithDepth(s, n), flights: map[string]*flight{}, verified: map[string]time.Time{}, fds: map[string]*list.Element{}}
}
func (c *Cache) Ensure(h string) (string, error) { return c.EnsureContext(context.Background(), h) }
func (c *Cache) EnsureContext(ctx context.Context, h string) (string, error) {
	for {
		p, e := c.ensure(ctx, h)
		if e == context.Canceled && ctx.Err() == nil && !store.IsBackground(ctx) {
			continue
		}
		return p, e
	}
}
func (c *Cache) ensure(ctx context.Context, h string) (string, error) {
	if !root.Hex(h, 64) {
		return "", fmt.Errorf("invalid hash")
	}
	p := filepath.Join(c.Dir, h[:2], h)
	c.mu.Lock()
	if last, ok := c.verified[h]; ok {
		c.Hits.Add(1)
		now := time.Now()
		if now.Sub(last) >= time.Minute {
			_ = os.Chtimes(p, now, now)
			c.verified[h] = now
		}
		c.mu.Unlock()
		return p, nil
	}
	if f := c.flights[h]; f != nil {
		if !store.IsBackground(ctx) && f.cancel != nil && !f.started {
			f.cancel()
		}
		c.mu.Unlock()
		select {
		case <-f.done:
			if f.pack && f.err != nil {
				return c.ensure(ctx, h)
			}
			return f.path, f.err
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	f := &flight{done: make(chan struct{})}
	if store.IsBackground(ctx) {
		var cancel context.CancelFunc
		ctx, cancel = context.WithCancel(ctx)
		f.cancel = cancel
		defer cancel()
	}
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
	ctx = store.OnFetchStart(ctx, func() { c.mu.Lock(); c.Fetches.Add(1); f.started = true; c.mu.Unlock() })
	ctx = store.OnFetchFinish(ctx, func(n int64) { c.Bytes.Add(n) })
	b, e := c.Store.Get(ctx, "c/"+h)
	if e == nil && (c.hash(b) != h || len(b) != int(root.ChunkSize)) {
		e = fmt.Errorf("chunk hash mismatch")
	}
	if e == nil {
		e = store.Atomic(p, b)
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
func (c *Cache) Fetch(ctx context.Context, hashes []string, n int) error {
	return store.Parallel(ctx, n, hashes, func(h string) error { _, e := c.EnsureContext(ctx, h); return e })
}

func (c *Cache) hash(b []byte) string { c.Hashes.Add(1); return root.Hash(b) }
