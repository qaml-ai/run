package image

import (
	"context"
	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"testing"
)

func TestRealReflinkCheckpoint(t *testing.T) {
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "")
	data := t.TempDir()
	if e := Probe(data); e != nil {
		t.Skipf("filesystem does not support reflink: %v", e)
	}
	calls := 0
	original := extents
	extents = func(f *os.File) ([]extent, error) { calls++; return original(f) }
	defer func() { extents = original }()
	s := store.Local{Dir: t.TempDir()}
	db, e := refs.Open(filepath.Join(data, "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	m, e := New(Config{Data: data, HostID: "test"}, s, cache.New(filepath.Join(data, "cache"), s, 4), db)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	p := filepath.Join(data, "base.img")
	b := make([]byte, 4*root.ChunkSize)
	for i := range b {
		b[i] = 7
	}
	if e = os.WriteFile(p, b, 0600); e != nil {
		t.Fatal(e)
	}
	ctx := context.Background()
	imp, e := m.Import(ctx, ImportRequest{Lineage: "test", Name: "main", Path: p})
	if e != nil {
		t.Fatal(e)
	}
	v, e := m.Mount(ctx, Request{JobID: "job", Lineage: "test", Root: imp.Root, Fence: &refs.Fence{Holder: "runtime", Epoch: 1}})
	if e != nil {
		t.Fatal(e)
	}
	f, e := os.OpenFile(v.Image, os.O_RDWR, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	f.WriteAt([]byte("new bytes"), root.ChunkSize+8)
	cp, e := m.Checkpoint(ctx, "job")
	if e != nil || cp.ChangedChunks != 1 || cp.ParentRoot != imp.Root {
		t.Fatal(cp, e)
	}
	if e = unix.Fallocate(int(f.Fd()), unix.FALLOC_FL_PUNCH_HOLE|unix.FALLOC_FL_KEEP_SIZE, 2*root.ChunkSize, root.ChunkSize); e != nil {
		t.Fatal(e)
	}
	cp2, e := m.Checkpoint(ctx, "job")
	if e != nil || cp2.ChangedChunks != 1 || cp2.ParentRoot != cp.Root {
		t.Fatal(cp2, e)
	}
	r, e := m.load(ctx, cp2.Root)
	if e != nil || r.Chunks["524288"] != "" {
		t.Fatal(r, e)
	}
	calls = 0
	cp3, e := m.Checkpoint(ctx, "job")
	if e != nil || cp3.ChangedChunks != 0 || cp3.ChangedBytes != 0 || calls != 1 {
		t.Fatal(cp3, e)
	}
}
