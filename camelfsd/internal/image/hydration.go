package image

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/chunk"
)

type earlyResult struct {
	clean  bool
	done   chan struct{}
	ranges []chunk.Range
	err    error
}

// Called with the mount lock held. Only dm-clone writes unhydrated regions.
// A short suspension makes FICLONE the boundary between early guest writes
// and the private extents tracked by subsequent checkpoints.
func (m *Manager) hydratedSnapshot(ctx context.Context, v *Mount) error {
	if v.early != nil {
		return nil
	}
	if _, e := run(ctx, "dmsetup", "suspend", v.DM); e != nil {
		return e
	}
	p := filepath.Join(filepath.Dir(v.Dest), "hydrated.img")
	e := clone(v.Dest, p)
	_, re := run(context.Background(), "dmsetup", "resume", v.DM)
	if e != nil {
		return e
	}
	if re != nil {
		os.Remove(p)
		return re
	}
	v.hydrated = p
	v.hydrationRoot = v.Root
	result := &earlyResult{done: make(chan struct{})}
	v.early = result
	bg, cancel := context.WithCancel(context.Background())
	v.earlyCancel = cancel
	id := v.Root
	go func() {
		defer close(result.done)
		result.ranges, result.err = m.earlyWrites(bg, p, id)
		result.clean = result.err == nil && len(result.ranges) == 0
	}()
	return nil
}
func (m *Manager) earlyWrites(ctx context.Context, p, id string) ([]chunk.Range, error) {
	r, e := m.load(ctx, id)
	if e != nil {
		return nil, e
	}
	f, e := os.Open(p)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	var out []chunk.Range
	e = (chunk.Chunker{}).File(f, r.VirtualSize, func(o int64, h string, _ []byte) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		if h != r.Chunks[strconv.FormatInt(o, 10)] {
			out = append(out, chunk.Range{Offset: o, Length: min(chunk.Size, r.VirtualSize-o)})
		}
		return nil
	})
	return out, e
}
func (m *Manager) poll(v *Mount, stop <-chan struct{}) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-m.stop:
			return
		case <-ticker.C:
			v.mu.Lock()
			if v.State == "released" {
				v.mu.Unlock()
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			e := m.status(ctx, v)
			cancel()
			done := v.early != nil
			v.mu.Unlock()
			if e == nil && done {
				return
			}
		}
	}
}
