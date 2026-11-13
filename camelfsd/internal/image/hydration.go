package image

import (
	"context"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type hydration struct {
	done   chan struct{}
	cancel context.CancelFunc
	bytes  atomic.Int64
	err    error
}

// Fetch verified, non-hole chunks only. Completion never needs the mount lock:
// checkpoint and release may wait while holding it.
func (m *Manager) startHydration(v *Mount, r root.Root) {
	ctx, cancel := context.WithCancel(context.Background())
	h := &hydration{done: make(chan struct{}), cancel: cancel}
	v.hydration = h
	go func() {
		defer close(h.done)
		f, e := os.OpenFile(v.Dest, os.O_RDWR, 0)
		if e != nil {
			h.err = e
			return
		}
		defer f.Close()
		keys := make([]string, 0, len(r.Chunks))
		for key := range r.Chunks {
			keys = append(keys, key)
		}
		ctx = store.Background(ctx)
		h.err = store.Parallel(ctx, 64, keys, func(key string) error {
			p, e := m.Cache.EnsureContext(ctx, r.Chunks[key])
			if e != nil {
				return e
			}
			b, e := os.ReadFile(p)
			if e != nil {
				return e
			}
			off, _ := strconv.ParseInt(key, 10, 64)
			n, e := f.WriteAt(b[:min(int64(len(b)), r.VirtualSize-off)], off)
			if e == nil {
				h.bytes.Add(int64(n))
			}
			return e
		})
		if h.err == nil {
			h.err = f.Sync()
		}
	}()
	// Finish the swap even when no caller polls status.
	go func() {
		<-h.done
		v.mu.Lock()
		defer v.mu.Unlock()
		if v.State == "released" || h.err != nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if e := m.status(ctx, v); e != nil {
			v.HydrationError = e.Error()
		}
		_ = m.save(v)
	}()
}

func (m *Manager) awaitHydration(ctx context.Context, v *Mount) error {
	if v.hydration == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-v.hydration.done:
	}
	return m.status(ctx, v)
}
