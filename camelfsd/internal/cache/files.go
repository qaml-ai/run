package cache

import (
	"container/list"
	"context"
	"os"
	"path/filepath"
)

const openLimit = 256

type cachedFile struct {
	hash    string
	file    *os.File
	readers int
	retired bool
}

func (c *Cache) retire(f *cachedFile) {
	f.retired = true
	if f.readers == 0 {
		f.file.Close()
	}
}
func (c *Cache) ReadAt(h string, b []byte, offset int64) error {
	return c.ReadAtLineage("", h, b, offset)
}
func (c *Cache) ReadAtLineage(lineage, h string, b []byte, offset int64) error {
	for attempt := 0; ; attempt++ {
		retry, e := c.readAt(lineage, h, b, offset)
		if !retry || attempt == 1 {
			return e
		}
		c.Invalidate(h)
	}
}
func (c *Cache) readAt(lineage, h string, b []byte, offset int64) (bool, error) {
	var p string
	var e error
	if lineage == "" {
		p, e = c.Ensure(h)
	} else {
		p, e = c.EnsureLineage(context.Background(), lineage, h)
	}
	if e != nil {
		return false, e
	}
	c.fdMu.Lock()
	entry := c.fds[h]
	if entry == nil {
		f, e := os.Open(p)
		if e != nil {
			c.fdMu.Unlock()
			return os.IsNotExist(e), e
		}
		entry = c.lru.PushFront(&cachedFile{hash: h, file: f})
		c.fds[h] = entry
		if c.lru.Len() > openLimit {
			old := c.lru.Back()
			f := old.Value.(*cachedFile)
			delete(c.fds, f.hash)
			c.lru.Remove(old)
			c.retire(f)
		}
	} else {
		c.lru.MoveToFront(entry)
	}
	f := entry.Value.(*cachedFile)
	f.readers++
	c.fdMu.Unlock()
	_, e = f.file.ReadAt(b, offset)
	c.fdMu.Lock()
	f.readers--
	if f.retired && f.readers == 0 {
		f.file.Close()
	}
	c.fdMu.Unlock()
	return false, e
}

// Remove invalidates the trusted hit and open descriptor before eviction.
func (c *Cache) Remove(path string) error {
	h := filepath.Base(path)
	c.mu.Lock()
	if flight := c.flights[h]; flight != nil {
		c.mu.Unlock()
		<-flight.done
		return c.Remove(path)
	}
	defer c.mu.Unlock()
	c.invalidateLocked(h)
	return os.Remove(path)
}

// Invalidate retires a trusted path and descriptor without deleting a file.
func (c *Cache) Invalidate(h string) {
	c.mu.Lock()
	if f := c.flights[h]; f != nil {
		c.mu.Unlock()
		<-f.done
		c.Invalidate(h)
		return
	}
	defer c.mu.Unlock()
	c.invalidateLocked(h)
}
func (c *Cache) invalidateLocked(h string) {
	delete(c.verified, h)
	c.fdMu.Lock()
	if entry := c.fds[h]; entry != nil {
		delete(c.fds, h)
		c.lru.Remove(entry)
		c.retire(entry.Value.(*cachedFile))
	}
	c.fdMu.Unlock()
}
func (c *Cache) Close() {
	c.fdMu.Lock()
	defer c.fdMu.Unlock()
	for _, entry := range c.fds {
		c.retire(entry.Value.(*cachedFile))
	}
	c.fds = map[string]*list.Element{}
	c.lru.Init()
}
