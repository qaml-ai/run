package cache

import (
	"context"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"os"
	"path/filepath"
	"time"
)

// Missing includes disk entries not yet trusted in this process only when absent.
func (c *Cache) Missing(h string) bool {
	c.mu.Lock()
	_, ok := c.verified[h]
	c.mu.Unlock()
	if ok {
		return false
	}
	_, e := os.Stat(filepath.Join(c.Dir, h[:2], h))
	return e != nil
}

// Pack claims each missing chunk's single flight. Demand can join these flights.
// No byte from a corrupt pack is published, including chunks preceding corruption.
func (c *Cache) Pack(ctx context.Context, id string, hashes []string) (err error) {
	owned := map[string]*flight{}
	c.mu.Lock()
	for _, h := range hashes {
		if _, ok := c.verified[h]; !ok && c.flights[h] == nil {
			f := &flight{done: make(chan struct{})}
			c.flights[h] = f
			owned[h] = f
		}
	}
	c.mu.Unlock()
	if len(owned) == 0 {
		return nil
	}
	defer func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		for h, f := range owned {
			f.err = err
			delete(c.flights, h)
			close(f.done)
		}
	}()
	b, e := c.Store.Get(ctx, "p/"+id)
	c.Fetches.Add(1)
	c.Bytes.Add(int64(len(b)))
	if e != nil {
		return e
	}
	if len(b) != len(hashes)*int(root.ChunkSize) || root.PackID(hashes) != id {
		return fmt.Errorf("pack size or id mismatch")
	}
	for i, h := range hashes {
		if c.hash(b[int64(i)*root.ChunkSize:int64(i+1)*root.ChunkSize]) != h {
			return fmt.Errorf("pack chunk hash mismatch: %s", h)
		}
	}
	for i, h := range hashes {
		if f := owned[h]; f != nil {
			p := filepath.Join(c.Dir, h[:2], h)
			if e = store.Atomic(p, b[int64(i)*root.ChunkSize:int64(i+1)*root.ChunkSize]); e != nil {
				return e
			}
			f.path = p
			c.mu.Lock()
			c.verified[h] = time.Now()
			c.mu.Unlock()
		}
	}
	c.Packs.Add(1)
	return nil
}
