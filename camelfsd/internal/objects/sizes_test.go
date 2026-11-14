package objects

import (
	"context"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type sizeMetadataStore struct {
	store.Store
	heads int
}

func (s *sizeMetadataStore) Head(ctx context.Context, key string) (store.Info, error) {
	if strings.Contains(key, "/o/") {
		s.heads++
	}
	return s.Store.Head(ctx, key)
}
func (s *sizeMetadataStore) Get(ctx context.Context, key string) ([]byte, error) {
	if strings.Contains(key, "/o/") {
		panic("size lookup attempted blob GET")
	}
	return s.Store.Get(ctx, key)
}

func TestTreeWriterUsesIndexedSizeThenHEAD(t *testing.T) {
	r := repository(t)
	ctx := context.Background()
	blob, e := r.Upload(ctx, "l", "", 3, strings.NewReader("abc"))
	if e != nil {
		t.Fatal(e)
	}
	spy := &sizeMetadataStore{Store: r.Store}
	r.Store = spy
	raw := append([]byte("100644 file\x00"), mustSHA(t, blob.SHA1)...)
	for _, want := range []int{0, 1} {
		id, e := r.PutObject(ctx, "l", "tree", raw)
		if e != nil {
			t.Fatal(e)
		}
		if spy.heads != want {
			t.Fatalf("blob HEADs=%d, want %d", spy.heads, want)
		}
		entries, e := r.SizedTree(ctx, id)
		if e != nil || len(entries) != 1 || entries[0].Size != 3 {
			t.Fatal(entries, e)
		}
		if spy.heads != want {
			t.Fatal("read fetched blob metadata")
		}
		if _, e = r.DB.DB.Exec("DELETE FROM lineage_blobs"); e != nil {
			t.Fatal(e)
		}
	}
}

func mustSHA(t *testing.T, id string) []byte {
	t.Helper()
	b, e := hex.DecodeString(id)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
