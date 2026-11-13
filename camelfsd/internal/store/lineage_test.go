package store

import (
	"context"
	"errors"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLineageKeyValidationAndMetadata(t *testing.T) {
	id := strings.Repeat("a", 40)
	for _, key := range []string{"tenant:repo/t/" + id, "printable space/o/" + id} {
		if !valid(key) {
			t.Fatal(key)
		}
	}
	for _, key := range []string{"t/" + id, "l/" + strings.Repeat("a", 64), "../o/" + id, "bad\n/o/" + id, strings.Repeat("x", 129) + "/o/" + id, "a/b/o/" + id} {
		if valid(key) {
			t.Fatal("accepted", key)
		}
	}
	ctx := context.Background()
	local := Local{Dir: t.TempDir()}
	scoped := ForLineage(local, "tenant:repo")
	b := []byte("blob")
	key := BlobKey(b)
	if e := scoped.Put(ctx, key, b); e != nil {
		t.Fatal(e)
	}
	info, e := scoped.Head(ctx, key)
	if e != nil || info.Size != 4 || info.SHA256 != root.Hash(b) {
		t.Fatal(info, e)
	}
	if _, e := local.Head(ctx, "other/"+key); e == nil {
		t.Fatal("cross-lineage head succeeded")
	}
}

func TestPrefixedInventoryGatesSharedRootCache(t *testing.T) {
	ctx := context.Background()
	db, e := refs.Open(filepath.Join(t.TempDir(), "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	st := &Uploaded{Store: Local{Dir: t.TempDir()}, DB: db.DB}
	a, b := ForLineage(st, "a"), ForLineage(st, "b")
	raw := []byte("root")
	key := "r/" + root.Hash(raw)
	if e = a.Put(ctx, key, raw); e != nil {
		t.Fatal(e)
	}
	if _, e = b.Get(ctx, key); !errors.Is(e, os.ErrNotExist) {
		t.Fatal("shared root cache bypassed lineage prefix", e)
	}
	if e = b.Put(ctx, key, raw); e != nil {
		t.Fatal(e)
	}
	if got, e := b.Get(ctx, key); e != nil || string(got) != string(raw) {
		t.Fatal(string(got), e)
	}
	chunks := map[string][]byte{}
	chunk := make([]byte, root.ChunkSize)
	chunk[0] = 1
	chunks[root.Hash(chunk)] = chunk
	if n, e := PutChunks(ctx, a, chunks); e != nil || n != 1 {
		t.Fatal(n, e)
	}
	if n, e := PutChunks(ctx, a, chunks); e != nil || n != 0 {
		t.Fatal(n, e)
	}
	if n, e := PutChunks(ctx, b, chunks); e != nil || n != 1 {
		t.Fatal(n, e)
	}
}
