package nbd

import (
	"context"
	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"testing"
	"time"
)

func warmDevice(t testing.TB) *device {
	t.Helper()
	s := store.Local{Dir: t.TempDir()}
	b := make([]byte, root.ChunkSize)
	b[0] = 1
	h := root.Hash(b)
	if e := s.Put(context.Background(), "l/c/"+h, b); e != nil {
		t.Fatal(e)
	}
	c := cache.New(t.TempDir(), store.ForLineage(s, "l"), 64)
	t.Cleanup(c.Close)
	d := &device{lineage: "l", s: &Server{Cache: c}, r: root.Root{VirtualSize: root.ChunkSize, Chunks: map[string]string{"0": h}}}
	if e := d.readAt(make([]byte, 4096), 0); e != nil {
		t.Fatal(e)
	}
	return d
}
func TestWarmReadAtNoHash(t *testing.T) {
	d := warmDevice(t)
	before := d.s.Cache.Hashes.Load()
	b := make([]byte, 4096)
	start := time.Now()
	const n = 10000
	for i := 0; i < n; i++ {
		if e := d.readAt(b, int64(i%64)*4096); e != nil {
			t.Fatal(e)
		}
	}
	elapsed := time.Since(start) / n
	if d.s.Cache.Hashes.Load() != before {
		t.Fatal("warm read hashes")
	}
	t.Logf("warm 4 KiB readAt: %s/call, zero hashes", elapsed)
	if elapsed >= 50*time.Microsecond {
		t.Fatalf("warm readAt %s >= 50us", elapsed)
	}
}
func BenchmarkWarmReadAt4K(b *testing.B) {
	d := warmDevice(b)
	buf := make([]byte, 4096)
	before := d.s.Cache.Hashes.Load()
	b.SetBytes(4096)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if e := d.readAt(buf, int64(i%64)*4096); e != nil {
			b.Fatal(e)
		}
	}
	b.StopTimer()
	if d.s.Cache.Hashes.Load() != before {
		b.Fatal("warm read hashes")
	}
}
