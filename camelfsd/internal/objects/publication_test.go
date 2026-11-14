package objects

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type publicationPuts struct {
	store.Store
	count atomic.Int32
}

func (s *publicationPuts) Put(ctx context.Context, key string, b []byte) error {
	s.count.Add(1)
	return s.Store.Put(ctx, key, b)
}

func TestPublicationCacheRollsBackAndRetries(t *testing.T) {
	ctx := t.Context()
	r := repository(t)
	spy := &publicationPuts{Store: r.Store}
	// Host repositories already wrap their store with upload inventory.
	r.Store = &store.Uploaded{Store: store.WithDepth(spy, 64), DB: r.DB.DB}
	batch := r.ForLineage("l").BeginPublication()
	if _, err := batch.StageSizedTree(ctx, []Entry{}); err != nil {
		t.Fatal(err)
	}
	if _, err := batch.PutObject(ctx, "l", "commit", []byte("commit")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.DB.DB.Exec(`CREATE TRIGGER reject_upload BEFORE INSERT ON uploaded
BEGIN SELECT RAISE(ABORT, 'publication failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := batch.Flush(ctx); err == nil || err.Error() != "publication failure" {
		t.Fatalf("flush = %v", err)
	}
	assertRows := func(query string, want int) {
		t.Helper()
		var got int
		if err := r.DB.DB.QueryRow(query).Scan(&got); err != nil || got != want {
			t.Fatalf("%s: count=%d want=%d err=%v", query, got, want, err)
		}
	}
	assertRows("SELECT count(*) FROM objects", 0)
	assertRows("SELECT count(*) FROM tree_sizes", 0)
	assertRows("SELECT count(*) FROM lineage_objects", 0)
	assertRows("SELECT count(*) FROM uploaded", 0)
	if got := spy.count.Load(); got != 3 {
		t.Fatalf("durable PUTs=%d want=3", got)
	}
	if _, err := r.DB.DB.Exec("DROP TRIGGER reject_upload"); err != nil {
		t.Fatal(err)
	}
	if err := batch.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	assertRows("SELECT count(*) FROM objects", 2)
	assertRows("SELECT count(*) FROM tree_sizes", 1)
	assertRows("SELECT count(*) FROM lineage_objects", 2)
	assertRows("SELECT count(*) FROM uploaded", 3)
	if got := spy.count.Load(); got != 6 {
		t.Fatalf("durable PUTs including retry=%d want=6", got)
	}
}
