package image

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestSparse64GiBImport(t *testing.T) {
	m, _ := unit3(t)
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "")
	if e := Probe(m.Data); e != nil {
		t.Skip("needs reflink to promote without copying holes", e)
	}
	p := filepath.Join(m.Data, "sparse-import.img")
	f, e := os.Create(p)
	if e != nil {
		t.Fatal(e)
	}
	const size = int64(64 << 30)
	if e = f.Truncate(size); e != nil {
		t.Fatal(e)
	}
	for _, off := range []int64{4096, 32 << 30, size - 4096} {
		if _, e = f.WriteAt([]byte("sparse-data"), off); e != nil {
			t.Fatal(e)
		}
	}
	f.Close()
	imp, e := m.Import(context.Background(), ImportRequest{Lineage: "l", Path: p})
	if e != nil {
		t.Fatal(e)
	}
	r, e := m.load(context.Background(), "l", imp.Root)
	if e != nil {
		t.Fatal(e)
	}
	if r.VirtualSize != size || len(r.Chunks) != 3 || imp.Chunks != 3 {
		t.Fatal(r.VirtualSize, r.Chunks, imp)
	}
	st, e := os.Stat(m.image(imp.Root))
	if e != nil || st.Size() != size {
		t.Fatal(st, e)
	}
	t.Logf("64 GiB sparse import: %d chunks, %.1f ms", imp.Chunks, imp.ImportMs)
}
