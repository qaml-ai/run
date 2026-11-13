package image

import (
	"context"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"os"
	"sort"
	"strconv"
	"sync"
)

// packWriter retains at most one assembling pack plus fetch-depth uploads.
// The caller adds chunks in image offset order and waits before publishing a root.
type packWriter struct {
	m         *Manager
	ctx       context.Context
	locations map[string]root.Location
	seen      map[string]bool
	hashes    []string
	bytes     []byte
	sem       chan struct{}
	wg        sync.WaitGroup
	mu        sync.Mutex
	err       error
	uploaded  int
	packBytes int64
}

func (m *Manager) writer(ctx context.Context, r *root.Root) *packWriter {
	if r.Locations == nil {
		r.Locations = map[string]root.Location{}
	}
	return &packWriter{m: m, ctx: ctx, locations: r.Locations, seen: map[string]bool{}, sem: make(chan struct{}, store.Depth(m.Store))}
}
func (w *packWriter) add(h string, b []byte) error {
	if h == "" || w.seen[h] {
		return nil
	}
	w.seen[h] = true
	if _, ok := w.locations[h]; ok {
		return nil
	}
	if s, ok := w.m.Store.(*store.Uploaded); ok {
		l, found, e := s.Location(w.ctx, h)
		if e != nil {
			return e
		}
		if found {
			w.locations[h] = l
			return nil
		}
	}
	w.hashes = append(w.hashes, h)
	w.bytes = append(w.bytes, b...)
	if int64(len(w.bytes)) >= w.m.PackMax {
		return w.flush()
	}
	return nil
}
func (w *packWriter) flush() error {
	if len(w.hashes) == 0 {
		return nil
	}
	select {
	case w.sem <- struct{}{}:
	case <-w.ctx.Done():
		return w.ctx.Err()
	}
	id := root.PackID(w.hashes)
	b := w.bytes
	for i, h := range w.hashes {
		w.locations[h] = root.Location{Pack: id, Index: i}
	}
	chunks := len(w.hashes)
	w.hashes = nil
	w.bytes = nil
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		defer func() { <-w.sem }()
		sent, e := store.PutPack(w.ctx, w.m.Store, id, b)
		w.mu.Lock()
		defer w.mu.Unlock()
		if e != nil {
			if w.err == nil {
				w.err = e
			}
		} else if sent {
			w.uploaded += chunks
			w.packBytes += int64(len(b))
			w.m.PackBytes.Add(int64(len(b)))
		}
	}()
	return nil
}
func (w *packWriter) finish() error {
	e := w.flush()
	w.wg.Wait()
	if e != nil {
		return e
	}
	return w.err
}

// Repack converts a legacy root without changing refs or deleting old objects.
func (m *Manager) Repack(ctx context.Context, id string) (string, error) {
	r, e := m.load(ctx, id)
	if e != nil {
		return "", e
	}
	w := m.writer(ctx, &r)
	for _, k := range sortedOffsets(r.Chunks) {
		h := r.Chunks[k]
		p, e := m.Cache.EnsureContext(ctx, h)
		if e != nil {
			_ = w.finish()
			return "", e
		}
		b, e := os.ReadFile(p)
		if e != nil {
			_ = w.finish()
			return "", e
		}
		if e = w.add(h, b); e != nil {
			_ = w.finish()
			return "", e
		}
	}
	if e = w.finish(); e != nil {
		return "", e
	}
	b, e := root.Encode(r)
	if e != nil {
		return "", e
	}
	next := root.Hash(b)
	if e = m.Store.Put(ctx, "r/"+next, b); e != nil {
		return "", fmt.Errorf("publish repack: %w", e)
	}
	return next, nil
}

func sortedOffsets(chunks map[string]string) []string {
	var keys []string
	for k := range chunks {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, _ := strconv.ParseInt(keys[i], 10, 64)
		b, _ := strconv.ParseInt(keys[j], 10, 64)
		return a < b
	})
	return keys
}
