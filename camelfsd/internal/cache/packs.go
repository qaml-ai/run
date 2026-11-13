package cache

import (
	"context"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"os"
	"path/filepath"
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

// Pack fetches a complete, known membership list through the shared flights.
func (c *Cache) Pack(ctx context.Context, id string, hashes []string) error {
	if root.PackID(hashes) != id {
		return fmt.Errorf("pack id mismatch")
	}
	members := map[int]string{}
	for i, h := range hashes {
		members[i] = h
	}
	return c.packSpan(ctx, id, members, 0, 0, true)
}
