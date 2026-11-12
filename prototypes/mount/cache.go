package main

// The host-wide blob cache: a directory of verified blobs named by their sha256 (cache/ab/abcdef...), shared by every
// mount on the host. A blob is fetched once, checked against its hash, and renamed into place, so a reader never sees
// a partial or wrong blob and two jobs (or a base and its fork) asking for the same content share one copy and one
// fetch.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

type Cache struct {
	dir    string
	server string
	client *http.Client

	mu       sync.Mutex
	inflight map[string]*fetch

	hits, misses, joins, fetchedBytes atomic.Int64
	fetchNanos                        atomic.Int64
}

type fetch struct {
	done chan struct{}
	err  error
}

func NewCache(dir, server string) *Cache {
	os.MkdirAll(dir, 0o755)
	return &Cache{dir: dir, server: server, inflight: map[string]*fetch{},
		client: &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 64, MaxConnsPerHost: 64}}}
}

func (c *Cache) Path(h string) string { return filepath.Join(c.dir, h[:2], h) }

// Ensure returns the local path of blob h, fetching it if needed. `demand` is false for prefetches, which are not
// counted as hits or misses (they count fetched bytes only).
func (c *Cache) Ensure(h string, demand bool) (string, error) {
	p := c.Path(h)
	if _, err := os.Stat(p); err == nil {
		if demand {
			c.hits.Add(1)
		}
		return p, nil
	}
	c.mu.Lock()
	if f, ok := c.inflight[h]; ok {
		c.mu.Unlock()
		if demand {
			c.joins.Add(1)
		}
		<-f.done
		return p, f.err
	}
	f := &fetch{done: make(chan struct{})}
	c.inflight[h] = f
	c.mu.Unlock()
	if demand {
		c.misses.Add(1)
	}
	f.err = c.fetch(h, p)
	c.mu.Lock()
	delete(c.inflight, h)
	c.mu.Unlock()
	close(f.done)
	return p, f.err
}

func (c *Cache) fetch(h, p string) error {
	began := time.Now()
	defer func() { c.fetchNanos.Add(int64(time.Since(began))) }()
	resp, err := c.client.Get(c.server + "/blob/" + h)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("blob %s: %s", h[:12], resp.Status)
	}
	os.MkdirAll(filepath.Dir(p), 0o755)
	tmp, err := os.CreateTemp(filepath.Dir(p), ".f-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	sum := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, sum), resp.Body)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if hex.EncodeToString(sum.Sum(nil)) != h {
		return fmt.Errorf("blob %s: integrity check failed", h[:12])
	}
	// Read-only: a blob in the cache is never written in place (the overlay copies up instead).
	os.Chmod(tmp.Name(), 0o444)
	c.fetchedBytes.Add(n)
	return os.Rename(tmp.Name(), p)
}

func (c *Cache) Stats() map[string]int64 {
	return map[string]int64{"hits": c.hits.Load(), "misses": c.misses.Load(), "joins": c.joins.Load(),
		"fetchedBytes": c.fetchedBytes.Load(), "fetchMs": c.fetchNanos.Load() / 1e6}
}
