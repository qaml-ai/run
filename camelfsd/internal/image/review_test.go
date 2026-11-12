package image

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestTreeMountReclaimsExpiredJobLease(t *testing.T) {
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "1")
	data := t.TempDir()
	s := store.Local{Dir: t.TempDir()}
	db, e := refs.Open(filepath.Join(data, "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	m, e := New(Config{Data: data, Cold: "prehydrate", HostID: "test"}, s, cache.New(filepath.Join(data, "cache"), s, 4), db)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	path := filepath.Join(data, "base.img")
	if e = os.WriteFile(path, make([]byte, root.ChunkSize), 0600); e != nil {
		t.Fatal(e)
	}
	tree := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	imp, e := m.Import(context.Background(), ImportRequest{Lineage: "l", Name: "main", Path: path, Tree: tree})
	if e != nil {
		t.Fatal(e)
	}
	db.Ensure("l", "job/retry")
	db.CAS("l", "job/retry", refs.Value{}, refs.Value{Root: imp.Root, Tree: tree, Owner: "job:retry"}, refs.Fence{})
	db.Now = func() time.Time { return time.Now().Add(-10 * time.Minute) }
	epoch, e := db.Lease("l", "job/retry", "crashed")
	if e != nil {
		t.Fatal(e)
	}
	db.Now = time.Now
	mount, e := m.Mount(context.Background(), Request{JobID: "retry", Lineage: "l", Tree: tree})
	if e != nil {
		t.Fatal(e)
	}
	if mount.LeaseEpoch <= epoch || mount.Root != imp.Root {
		t.Fatal(mount)
	}
}
func TestSparseHolesOnlyReadParentChunks(t *testing.T) {
	const size = int64(4 << 30)
	if got := rangesFromExtents(nil, size, nil); len(got) != 0 {
		t.Fatal(got)
	}
	got := rangesFromExtents(nil, size, map[string]string{"262144": "hash"})
	want := []chunk.Range{{Offset: root.ChunkSize, Length: root.ChunkSize}}
	if !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
	// A hole inside a parent chunk still hashes the chunk and catches a punch.
	got = rangesFromExtents([]extent{{Logical: 0, Length: 4096, Flags: 0x2000}}, size, map[string]string{"0": "hash"})
	want = []chunk.Range{{Offset: 4096, Length: root.ChunkSize - 4096}}
	if !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
}
