package image

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func packFiles(t *testing.T, m *Manager) (int, int64) {
	t.Helper()
	s := m.Store.(*store.Uploaded).Store.(store.Local)
	files, e := os.ReadDir(filepath.Join(s.Dir, "p"))
	if e != nil {
		t.Fatal(e)
	}
	var size int64
	for _, f := range files {
		st, e := f.Info()
		if e != nil {
			t.Fatal(e)
		}
		size += st.Size()
	}
	return len(files), size
}
func TestPackImportCheckpointRevert(t *testing.T) {
	m, _ := unit3(t)
	ctx := context.Background()
	m.PackMax = 4 * root.ChunkSize
	data := make([]byte, 12*root.ChunkSize)
	for i := 0; i < 12; i++ {
		data[int64(i)*root.ChunkSize] = byte(i + 1)
	}
	path := filepath.Join(m.Data, "source.img")
	if e := os.WriteFile(path, data, 0600); e != nil {
		t.Fatal(e)
	}
	imp, e := m.Import(ctx, ImportRequest{Lineage: "l", Name: "main", Path: path})
	if e != nil {
		t.Fatal(e)
	}
	r, e := m.load(ctx, imp.Root)
	if e != nil {
		t.Fatal(e)
	}
	if len(r.Locations) != 12 {
		t.Fatal(r)
	}
	count, size := packFiles(t, m)
	if count != 3 || size != int64(len(data)) || imp.PackBytes != size {
		t.Fatal(count, size, imp)
	}
	local := m.Store.(*store.Uploaded).Store.(store.Local)
	if files, _ := os.ReadDir(filepath.Join(local.Dir, "c")); len(files) != 0 {
		t.Fatal("wrote chunk objects")
	}
	cold := cache.New(t.TempDir(), local, 64)
	defer cold.Close()
	cold.Locations(r.Locations)
	for k, h := range r.Chunks {
		p, e := cold.Ensure(h)
		if e != nil {
			t.Fatal(e)
		}
		b, e := os.ReadFile(p)
		o, _ := strconv.ParseInt(k, 10, 64)
		if e != nil || !bytes.Equal(b, data[o:o+root.ChunkSize]) {
			t.Fatal("range bytes", e)
		}
	}
	if cold.RangeGets.Load() != 12 || cold.PackGets.Load() != 0 {
		t.Fatal("demand accounting")
	}
	v, e := m.Mount(ctx, Request{JobID: "edit", Lineage: "l", Ref: "main"})
	if e != nil {
		t.Fatal(e)
	}
	// Three small file edits represented by three changed image chunks.
	f, e := os.OpenFile(v.Dest, os.O_RDWR, 0)
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 3; i++ {
		if _, e = f.WriteAt([]byte{byte(99 + i)}, int64(i)*root.ChunkSize); e != nil {
			t.Fatal(e)
		}
	}
	f.Close()
	cp, e := m.Checkpoint(ctx, v.JobID)
	if e != nil {
		t.Fatal(e)
	}
	next, e := m.load(ctx, cp.Root)
	if e != nil {
		t.Fatal(e)
	}
	n, b := packFiles(t, m)
	if n != count+1 || b-size != 3*root.ChunkSize || cp.UploadedChunks != 3 {
		t.Fatal(n, b, cp)
	}
	var newPack string
	for i := 0; i < 12; i++ {
		h := next.Chunks[strconv.FormatInt(int64(i)*root.ChunkSize, 10)]
		l := next.Locations[h]
		if i < 3 {
			if newPack == "" {
				newPack = l.Pack
			}
			if l.Pack != newPack {
				t.Fatal("split delta")
			}
		} else if l != r.Locations[h] {
			t.Fatal("unchanged location moved")
		}
	}
	f, e = os.OpenFile(v.Dest, os.O_RDWR, 0)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.WriteAt(data[:root.ChunkSize], 0); e != nil {
		t.Fatal(e)
	}
	f.Close()
	revert, e := m.Checkpoint(ctx, v.JobID)
	if e != nil {
		t.Fatal(e)
	}
	rr, e := m.load(ctx, revert.Root)
	if e != nil {
		t.Fatal(e)
	}
	n2, b2 := packFiles(t, m)
	h := r.Chunks["0"]
	if n2 != n || b2 != b || revert.UploadedChunks != 0 || rr.Locations[h] != r.Locations[h] {
		t.Fatal("revert uploaded", revert)
	}
	// Fresh host learns locations from reading a self-contained root.
	db, e := refs.Open(filepath.Join(t.TempDir(), "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	reader := &store.Uploaded{Store: local, DB: db.DB}
	if _, e = reader.Get(ctx, "r/"+imp.Root); e != nil {
		t.Fatal(e)
	}
	if l, ok, e := reader.Location(ctx, h); e != nil || !ok || l != r.Locations[h] {
		t.Fatal(l, ok, e)
	}
	t.Logf("storage bytes=%d image bytes=%d amplification=1.00 c_objects=0; checkpoint packs=1 bytes=%d", size, len(data), b-size)
}
func TestLegacyMountAndRepack(t *testing.T) {
	m, _ := unit3(t)
	ctx := context.Background()
	b := make([]byte, root.ChunkSize)
	b[0] = 42
	h := root.Hash(b)
	if e := m.Store.Put(ctx, "c/"+h, b); e != nil {
		t.Fatal(e)
	}
	r := root.Root{V: 1, FSType: "ext4", VirtualSize: root.ChunkSize, Chunks: map[string]string{"0": h}}
	encoded, e := root.Encode(r)
	if e != nil {
		t.Fatal(e)
	}
	id := root.Hash(encoded)
	if e = m.Store.Put(ctx, "r/"+id, encoded); e != nil {
		t.Fatal(e)
	}
	v, e := m.Mount(ctx, Request{JobID: "legacy", Lineage: "l", Root: id})
	if e != nil {
		t.Fatal(e)
	}
	got, e := os.ReadFile(v.Image)
	if e != nil || !bytes.Equal(got, b) {
		t.Fatal("legacy mount", e)
	}
	if e = m.Refs.CAS("l", "legacy", refs.Value{}, refs.Value{Root: id}, refs.Fence{}); e != nil {
		t.Fatal(e)
	}
	next, e := m.Repack(ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	rr, e := m.load(ctx, next)
	if e != nil || len(rr.Locations) != 1 || next == id {
		t.Fatal(rr, e)
	}
	c := cache.New(t.TempDir(), m.Store, 64)
	defer c.Close()
	c.Locations(rr.Locations)
	if _, e = c.Ensure(h); e != nil {
		t.Fatal(e)
	}
	ref, e := m.Refs.Get("l", "legacy")
	if e != nil || ref.Root != id {
		t.Fatal("repack changed ref", ref, e)
	}
	again, e := m.Repack(ctx, next)
	if e != nil || again != next {
		t.Fatal("repack not idempotent", again, e)
	}
}
