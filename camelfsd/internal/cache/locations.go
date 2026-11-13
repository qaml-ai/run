package cache

import (
	"context"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"path/filepath"
	"sort"
	"time"
)

func (c *Cache) Locations(ls map[string]root.Location) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.locations == nil {
		c.locations = map[string]root.Location{}
	}
	for h, l := range ls {
		c.locations[h] = l
	}
}

// PrefetchChunk coalesces adjacent missing pack members in the lookahead window.
func (c *Cache) PrefetchChunk(ctx context.Context, r root.Root, h string, lookahead int) error {
	l, ok := r.Locations[h]
	if !ok {
		_, e := c.EnsureContext(ctx, h)
		return e
	}
	if !c.Missing(h) {
		_, e := c.EnsureContext(ctx, h)
		return e
	}
	members := r.Members(l.Pack)
	missing := map[int]string{}
	for i, hash := range members {
		if c.Missing(hash) {
			missing[i] = hash
		}
	}
	if len(missing) == 0 {
		return nil
	}
	// A complete membership list proves the size without another store call.
	total := 0
	var hs []string
	for i := 0; i < len(members); i++ {
		if members[i] == "" {
			break
		}
		hs = append(hs, members[i])
	}
	if len(hs) == len(members) && root.PackID(hs) == l.Pack {
		total = len(hs)
	}
	if total == 0 && store.IsBackground(ctx) {
		n, e := c.packSize(ctx, l.Pack)
		if e != nil {
			return e
		}
		total = n
	}
	whole := store.IsBackground(ctx) && len(missing)*2 >= total
	if whole {
		return c.packSpan(ctx, l.Pack, missing, 0, 0, true)
	}
	end := l.Index
	for i := l.Index + 1; i <= l.Index+lookahead; i++ {
		hash := members[i]
		if hash == "" || !c.Missing(hash) {
			break
		}
		end = i
	}
	span := map[int]string{}
	for i := l.Index; i <= end; i++ {
		span[i] = members[i]
	}
	return c.packSpan(ctx, l.Pack, span, l.Index, end-l.Index+1, false)
}
func (c *Cache) Prefetch(ctx context.Context, r root.Root) error {
	c.Locations(r.Locations)
	r = r.Indexed()
	groups := map[string][]string{}
	var keys []string
	for _, h := range r.Chunks {
		key := "c/" + h
		if l, ok := r.Locations[h]; ok {
			key = l.Pack
		}
		groups[key] = append(groups[key], h)
	}
	for k := range groups {
		keys = append(keys, k)
	}
	return store.Parallel(ctx, 64, keys, func(k string) error {
		for _, h := range groups[k] {
			if e := c.PrefetchChunk(store.Background(ctx), r, h, 64); e != nil {
				return e
			}
		}
		return nil
	})
}
func (c *Cache) packSpan(ctx context.Context, id string, members map[int]string, start, count int, whole bool) (err error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	owned := map[string]*flight{}
	c.mu.Lock()
	for _, h := range members {
		if _, ok := c.verified[h]; !ok && c.flights[h] == nil {
			f := &flight{done: make(chan struct{}), cancel: cancel, pack: true}
			owned[h] = f
			c.flights[h] = f
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
	ctx = store.OnFetchStart(ctx, func() {
		c.mu.Lock()
		c.Fetches.Add(1)
		for _, f := range owned {
			f.started = true
		}
		c.mu.Unlock()
	})
	ctx = store.OnFetchFinish(ctx, func(n int64) { c.Bytes.Add(n) })
	var b []byte
	if whole {
		c.PackGets.Add(1)
		b, err = c.Store.Get(ctx, "p/"+id)
	} else {
		c.RangeGets.Add(1)
		b, err = store.Range(ctx, c.Store, "p/"+id, int64(start)*root.ChunkSize, int64(count)*root.ChunkSize)
	}
	if err != nil {
		return err
	}
	if whole {
		if len(b) == 0 || len(b)%int(root.ChunkSize) != 0 || len(b) > 16<<20 {
			return fmt.Errorf("invalid pack size")
		}
		var hashes []string
		for o := int64(0); o < int64(len(b)); o += root.ChunkSize {
			hashes = append(hashes, c.hash(b[o:o+root.ChunkSize]))
		}
		if root.PackID(hashes) != id {
			return fmt.Errorf("pack hash mismatch")
		}
	}
	indices := make([]int, 0, len(members))
	for i := range members {
		indices = append(indices, i)
	}
	sort.Ints(indices)
	for _, i := range indices {
		off := int64(i-start) * root.ChunkSize
		if off < 0 || off+root.ChunkSize > int64(len(b)) || c.hash(b[off:off+root.ChunkSize]) != members[i] {
			return fmt.Errorf("pack chunk hash mismatch")
		}
	}
	for _, i := range indices {
		h := members[i]
		if f := owned[h]; f != nil {
			off := int64(i-start) * root.ChunkSize
			p := filepath.Join(c.Dir, h[:2], h)
			if err = store.Atomic(p, b[off:off+root.ChunkSize]); err != nil {
				return err
			}
			f.path = p
			c.mu.Lock()
			c.verified[h] = time.Now()
			c.mu.Unlock()
		}
	}
	if whole {
		c.Packs.Add(1)
	}
	return nil
}

type packSizeFlight struct {
	done chan struct{}
	n    int
	err  error
}

func (c *Cache) packSize(ctx context.Context, id string) (int, error) {
	f := &packSizeFlight{done: make(chan struct{})}
	actual, loaded := c.packSizes.LoadOrStore(id, f)
	if loaded {
		f = actual.(*packSizeFlight)
		select {
		case <-f.done:
			return f.n, f.err
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
	size, e := store.Size(ctx, c.Store, "p/"+id)
	if e == nil && (size < root.ChunkSize || size > 16<<20 || size%root.ChunkSize != 0) {
		e = fmt.Errorf("invalid pack size")
	}
	f.n = int(size / root.ChunkSize)
	f.err = e
	close(f.done)
	if e != nil {
		c.packSizes.Delete(id)
	}
	return f.n, f.err
}
