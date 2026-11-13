package nbd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type measuredStore struct {
	store.Store
	mu           sync.Mutex
	active, peak int
	started      chan string
	gate         chan struct{}
}

func (s *measuredStore) Get(ctx context.Context, k string) ([]byte, error) {
	s.mu.Lock()
	s.active++
	s.peak = max(s.peak, s.active)
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.active--; s.mu.Unlock() }()
	select {
	case s.started <- k:
	default:
	}
	if s.gate != nil {
		select {
		case <-s.gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return s.Store.Get(ctx, k)
}
func TestBoundedPoolAndPatternReplay(t *testing.T) {
	local := store.Local{Dir: t.TempDir()}
	r := root.Root{V: 1, FSType: "ext4", VirtualSize: 128 * root.ChunkSize, Chunks: map[string]string{}}
	for i := 0; i < 128; i++ {
		b := make([]byte, root.ChunkSize)
		copy(b, fmt.Sprint(i))
		h := root.Hash(b)
		if e := local.Put(context.Background(), "c/"+h, b); e != nil {
			t.Fatal(e)
		}
		r.Chunks[strconv.FormatInt(int64(i)*root.ChunkSize, 10)] = h
	}
	s := &measuredStore{Store: local, started: make(chan string, 256), gate: make(chan struct{})}
	server := &Server{Store: s, Cache: cache.New(t.TempDir(), s, 64), Prefetch: 3, Patterns: t.TempDir()}
	release := server.Register("r", "lineage", r)
	p := server.origins["r"]
	p.touch(9 * root.ChunkSize)
	p.touch(2 * root.ChunkSize)
	p.touch(9 * root.ChunkSize)
	for i := 0; i < 100; i++ {
		p.ahead(int64(i) * root.ChunkSize)
	}
	for i := 0; i < 3; i++ {
		select {
		case <-s.started:
		case <-time.After(time.Second):
			t.Fatal("pool did not fill")
		}
	}
	select {
	case <-s.started:
		t.Fatal("more than 3 workers")
	case <-time.After(20 * time.Millisecond):
	}
	close(s.gate)
	release()
	b, e := os.ReadFile(server.pattern("lineage"))
	if e != nil {
		t.Fatal(e)
	}
	var pattern []int64
	json.Unmarshal(b, &pattern)
	if fmt.Sprint(pattern) != fmt.Sprint([]int64{9 * root.ChunkSize, 2 * root.ChunkSize}) {
		t.Fatal(pattern)
	}
	replay := &measuredStore{Store: local, started: make(chan string, 16)}
	server.Cache = cache.New(filepath.Join(t.TempDir(), "fresh"), replay, 64)
	release = server.Register("next-root", "lineage", r)
	defer release()
	// No demand has been submitted: replay must already request both touches.
	seen := map[string]bool{}
	for i := 0; i < 2; i++ {
		select {
		case k := <-replay.started:
			seen[k] = true
		case <-time.After(time.Second):
			t.Fatal("missing replay")
		}
	}
	for _, o := range pattern {
		if !seen["c/"+r.Chunks[strconv.FormatInt(o, 10)]] {
			t.Fatal(seen)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.peak > 3 {
		t.Fatal(s.peak)
	}
}

func TestRootPrefetchOrderAndPackThreshold(t *testing.T) {
	for _, missing := range []int{7, 8, 16} {
		t.Run(fmt.Sprint(missing), func(t *testing.T) {
			ctx := context.Background()
			local := store.Local{Dir: t.TempDir()}
			r := root.Root{V: 1, FSType: "ext4", VirtualSize: 16 * root.ChunkSize, Chunks: map[string]string{}, Locations: map[string]root.Location{}}
			var data []byte
			for i := 0; i < 16; i++ {
				b := make([]byte, root.ChunkSize)
				b[0] = byte(i + 1)
				h := root.Hash(b)
				r.Chunks[strconv.FormatInt(int64(i)*root.ChunkSize, 10)] = h
				data = append(data, b...)
				if e := local.Put(ctx, "c/"+h, b); e != nil {
					t.Fatal(e)
				}
			}
			var hs []string
			for i := 0; i < 16; i++ {
				hs = append(hs, r.Chunks[strconv.FormatInt(int64(i)*root.ChunkSize, 10)])
			}
			id := root.PackID(hs)
			for i, h := range hs {
				r.Locations[h] = root.Location{Pack: id, Index: i}
			}
			if e := local.Put(ctx, "p/"+id, data); e != nil {
				t.Fatal(e)
			}
			measured := &measuredStore{Store: local, started: make(chan string, 32)}
			c := cache.New(t.TempDir(), measured, 64)
			defer c.Close()
			for _, h := range hs[missing:] {
				if _, e := c.Ensure(h); e != nil {
					t.Fatal(e)
				}
			}
			for len(measured.started) > 0 {
				<-measured.started
			}
			s := &Server{Store: local, Cache: c, FetchDepth: 1}
			release := s.Register("root", "", r)
			defer release()
			s.PrefetchRoot("root")
			want := missing
			if missing >= 8 {
				want = 1
			}
			for i := 0; i < want; i++ {
				select {
				case k := <-measured.started:
					expected := "p/" + id
					if missing >= 8 {
						expected = "p/" + id
					}
					if k != expected {
						t.Fatalf("got %s want %s", k, expected)
					}
				case <-time.After(2 * time.Second):
					t.Fatal("prefetch stalled")
				}
			}
		})
	}
}
