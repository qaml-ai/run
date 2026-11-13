package objects

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestPrefixedExistenceRebuildsDerivedLineageCaches(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	st := store.Local{Dir: dir}
	db, e := refs.Open(filepath.Join(t.TempDir(), "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	r := &Repository{DB: db, Store: st, TempDir: t.TempDir()}
	b, e := r.Upload(ctx, "tenant:repo", "", 5, strings.NewReader("hello"))
	if e != nil {
		t.Fatal(e)
	}
	tr, e := r.Import(ctx, Request{Lineage: "tenant:repo", Files: map[string]File{"file": {SHA256: b.SHA256}}})
	if e != nil {
		t.Fatal(e)
	}
	for _, key := range []string{"tenant:repo/o/" + b.SHA1, "tenant:repo/t/" + tr.Tree} {
		ok, e := st.Has(ctx, key)
		if !ok || e != nil {
			t.Fatal(key, e)
		}
	}
	info, e := st.Head(ctx, "tenant:repo/o/"+b.SHA1)
	if e != nil || info.Size != 5 || info.SHA256 != root.Hash([]byte("hello")) {
		t.Fatal(info, e)
	}
	if _, e = os.Stat(filepath.Join(dir, "tenant:repo", "o", b.SHA1) + ".meta"); e != nil {
		t.Fatal(e)
	}
	if _, e = db.DB.Exec("DELETE FROM lineage_objects; DELETE FROM lineage_blobs"); e != nil {
		t.Fatal(e)
	}
	for _, v := range [][2]string{{b.SHA1, "blob"}, {tr.Tree, "tree"}} {
		ok, e := r.Reachable(ctx, "tenant:repo", v[0], v[1])
		if e != nil || !ok {
			t.Fatal(v, e)
		}
		if ok, e = r.Reachable(ctx, "other", v[0], v[1]); e != nil || ok {
			t.Fatal("cross-lineage existence leaked", e)
		}
	}
	cached, e := r.BlobInfo(ctx, "tenant:repo", b.SHA1)
	if e != nil || cached.SHA256 != b.SHA256 || cached.Size != 5 {
		t.Fatal(cached, e)
	}
	// Evicting only blob metadata must recover it even with a warm object row.
	if _, e = db.DB.Exec("DELETE FROM lineage_blobs"); e != nil {
		t.Fatal(e)
	}
	if cached, e = r.BlobInfo(ctx, "tenant:repo", b.SHA1); e != nil || cached.SHA256 != b.SHA256 {
		t.Fatal(cached, e)
	}
	// Planted cache rows cannot become durable membership after cache eviction.
	fake := strings.Repeat("f", 40)
	_, e = db.DB.Exec("INSERT INTO lineage_objects VALUES(?,?,?,0)", "tenant:repo", fake, "blob")
	if e != nil {
		t.Fatal(e)
	}
	_, e = db.DB.Exec("INSERT INTO lineage_blobs VALUES(?,?,?,?,0)", "tenant:repo", strings.Repeat("e", 64), fake, 1)
	if e != nil {
		t.Fatal(e)
	}
	db.DB.Exec("DELETE FROM lineage_objects WHERE id=?", fake)
	db.DB.Exec("DELETE FROM lineage_blobs WHERE sha1=?", fake)
	ok, e := r.Reachable(ctx, "tenant:repo", fake, "blob")
	if e != nil || ok {
		t.Fatal(ok, e)
	}
	var n int
	e = db.DB.QueryRow("SELECT 1 FROM lineage_objects WHERE id=?", fake).Scan(&n)
	if e != sql.ErrNoRows {
		t.Fatal("invented membership cached", e)
	}
	// Re-uploading identical bytes to a second lineage creates its own object.
	_, e = r.Upload(ctx, "other", "", 5, strings.NewReader("hello"))
	if e != nil {
		t.Fatal(e)
	}
	if ok, _ := st.Has(ctx, "other/o/"+b.SHA1); !ok {
		t.Fatal("missing second lineage object")
	}
}
func TestRecordDoesNotInventMissingObjects(t *testing.T) {
	r := repository(t)
	id := strings.Repeat("a", 40)
	if e := r.Record(context.Background(), "l", id, "tree", nil); e == nil {
		t.Fatal("missing object recorded")
	}
	var count int
	r.DB.DB.QueryRow("SELECT count(*) FROM lineage_objects WHERE id=?", id).Scan(&count)
	if count != 0 {
		t.Fatal(count)
	}
}
