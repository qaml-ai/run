package cache

import (
	"context"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestLocationHydrationAndCorruption(t *testing.T) {
	ctx := context.Background()
	s := store.Local{Dir: t.TempDir()}
	r := root.Root{Chunks: map[string]string{}, Locations: map[string]root.Location{}}
	var b []byte
	var hs []string
	for i := 0; i < 4; i++ {
		v := make([]byte, root.ChunkSize)
		v[0] = byte(i + 1)
		hs = append(hs, root.Hash(v))
		b = append(b, v...)
	}
	id := root.PackID(hs)
	for i, h := range hs {
		r.Chunks[strconv.FormatInt(int64(i)*root.ChunkSize, 10)] = h
		r.Locations[h] = root.Location{Pack: id, Index: i}
	}
	if e := s.Put(ctx, "p/"+id, b); e != nil {
		t.Fatal(e)
	}
	c := New(t.TempDir(), s, 64)
	defer c.Close()
	if e := c.Prefetch(ctx, r); e != nil {
		t.Fatal(e)
	}
	if c.PackGets.Load() != 1 || c.RangeGets.Load() != 0 {
		t.Fatal("whole-pack accounting")
	}
	for _, h := range hs {
		if c.Missing(h) {
			t.Fatal("missing chunk")
		}
	}
	demand := New(t.TempDir(), s, 64)
	defer demand.Close()
	if e := demand.PrefetchChunk(ctx, r, hs[1], 2); e != nil {
		t.Fatal(e)
	}
	if demand.RangeGets.Load() != 1 || demand.Bytes.Load() != 3*root.ChunkSize {
		t.Fatal("did not coalesce adjacent demand chunks")
	}
	b[len(b)-1] ^= 1
	if e := os.WriteFile(filepath.Join(s.Dir, "p", id), b, 0600); e != nil {
		t.Fatal(e)
	}
	bad := New(t.TempDir(), s, 64)
	defer bad.Close()
	if e := bad.Prefetch(ctx, r); e == nil {
		t.Fatal("accepted corruption")
	}
	for _, h := range hs {
		if !bad.Missing(h) {
			t.Fatal("published corrupt pack")
		}
	}
}

func TestPartialRootUsesHalfPackThreshold(t *testing.T) {
	ctx := context.Background()
	s := store.Local{Dir: t.TempDir()}
	var b []byte
	var hs []string
	for i := 0; i < 4; i++ {
		v := make([]byte, root.ChunkSize)
		v[0] = byte(i + 1)
		b = append(b, v...)
		hs = append(hs, root.Hash(v))
	}
	id := root.PackID(hs)
	if e := s.Put(ctx, "p/"+id, b); e != nil {
		t.Fatal(e)
	}
	r := root.Root{Chunks: map[string]string{"0": hs[1], "262144": hs[2]}, Locations: map[string]root.Location{hs[1]: {Pack: id, Index: 1}, hs[2]: {Pack: id, Index: 2}}}
	c := New(t.TempDir(), s, 64)
	defer c.Close()
	if e := c.Prefetch(ctx, r); e != nil {
		t.Fatal(e)
	}
	if c.PackGets.Load() != 1 {
		t.Fatal("half of partial pack did not use whole GET")
	}
}
