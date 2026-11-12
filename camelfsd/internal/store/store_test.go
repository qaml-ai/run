package store

import (
	"context"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"testing"
)

func TestVerifiedKeys(t *testing.T) {
	s := Local{Dir: t.TempDir()}
	ctx := context.Background()
	b := make([]byte, root.ChunkSize)
	b[0] = 1
	h := root.Hash(b)
	if e := s.Put(ctx, "c/"+h, b); e != nil {
		t.Fatal(e)
	}
	if ok, e := s.Has(ctx, "c/"+h); !ok || e != nil {
		t.Fatal(ok, e)
	}
	b[1] = 2
	if e := s.Put(ctx, "c/"+h, b); e == nil {
		t.Fatal("accepted wrong hash")
	}
	if _, e := s.Get(ctx, "../../etc/passwd"); e == nil {
		t.Fatal("accepted invalid key")
	}
	blob := []byte("blob")
	if e := s.Put(ctx, BlobKey(blob), blob); e != nil {
		t.Fatal(e)
	}
}
