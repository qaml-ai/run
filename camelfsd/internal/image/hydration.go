package image

import (
	"context"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"os"
	"path/filepath"
	"sort"
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
	source, e := os.Open(v.Dest)
	var private []extent
	if e == nil {
		private, e = extents(source)
		source.Close()
	}
	if e == nil {
		e = clone(v.Dest, p)
	}
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
		result.ranges, result.err = m.earlyWrites(bg, p, id, private)
		result.clean = result.err == nil && len(result.ranges) == 0
	}()
	return nil
}
func (m *Manager) earlyWrites(ctx context.Context, p, id string, before ...[]extent) ([]chunk.Range, error) {
	r, e := m.load(ctx, id)
	if e != nil {
		return nil, e
	}
	f, e := os.Open(p)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	es, e := extents(f)
	if e != nil {
		return nil, e
	}
	// Reflinking itself makes source-private extents shared. Preserve the
	// pre-reflink view for new writes outside the parent root.
	for _, saved := range before {
		es = append(es, saved...)
	}
	hashRanges, out := earlyRanges(r, es)
	e = (chunk.Chunker{}).Ranges(f, r.VirtualSize, hashRanges, func(o int64, h string, _ []byte) error {
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
func hydrationInterval(elapsed time.Duration) time.Duration {
	if elapsed >= time.Second {
		return time.Second
	}
	return 100 * time.Millisecond
}
func pollHydration(stop, hostStop <-chan struct{}, ticks <-chan time.Time, reset func(time.Duration), start time.Time, check func() bool) {
	interval := 100 * time.Millisecond
	for {
		select {
		case <-stop:
			return
		case <-hostStop:
			return
		case now := <-ticks:
			select {
			case <-stop:
				return
			case <-hostStop:
				return
			default:
			}
			if check() {
				return
			}
			next := hydrationInterval(now.Sub(start))
			if next != interval {
				reset(next)
				interval = next
			}
		}
	}
}
func (m *Manager) poll(v *Mount, stop <-chan struct{}) {
	start := time.Now()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	pollHydration(stop, m.stop, ticker.C, ticker.Reset, start, func() bool {
		v.mu.Lock()
		defer v.mu.Unlock()
		if v.State == "released" {
			return true
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		e := m.status(ctx, v)
		return e == nil && v.early != nil
	})
}

// Parent chunks may have changed or become holes. Private non-parent extents
// are necessarily new writes; mark their chunks without reading sparse holes.
func earlyRanges(r root.Root, es []extent) (hashes, changed []chunk.Range) {
	for key := range r.Chunks {
		o, _ := strconv.ParseInt(key, 10, 64)
		hashes = append(hashes, chunk.Range{Offset: o, Length: min(chunk.Size, r.VirtualSize-o)})
	}
	seen := map[int64]bool{}
	for _, x := range es {
		if x.Flags&0x2000 != 0 {
			continue
		}
		end := min(r.VirtualSize, int64(x.Logical+x.Length))
		for o := int64(x.Logical) / chunk.Size * chunk.Size; o < end; o += chunk.Size {
			if _, ok := r.Chunks[strconv.FormatInt(o, 10)]; !ok && !seen[o] {
				changed = append(changed, chunk.Range{Offset: o, Length: min(chunk.Size, r.VirtualSize-o)})
				seen[o] = true
			}
		}
	}
	sort.Slice(hashes, func(i, j int) bool { return hashes[i].Offset < hashes[j].Offset })
	sort.Slice(changed, func(i, j int) bool { return changed[i].Offset < changed[j].Offset })
	return
}
