package cache

import (
	"context"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"os"
	"path/filepath"
	"testing"
)

func TestPackSplitAndCorruption(t *testing.T) {
	ctx := context.Background()
	s := store.Local{Dir: t.TempDir()}
	var data []byte
	var hs []string
	for i := 0; i < 16; i++ {
		b := make([]byte, root.ChunkSize)
		b[0] = byte(i + 1)
		hs = append(hs, root.Hash(b))
		data = append(data, b...)
	}
	id := root.PackID(hs)
	if e := s.Put(ctx, "p/"+id, data); e != nil {
		t.Fatal(e)
	}
	c := New(t.TempDir(), s, 64)
	defer c.Close()
	if e := c.Pack(ctx, id, hs); e != nil {
		t.Fatal(e)
	}
	for _, h := range hs {
		if c.Missing(h) {
			t.Fatal("missing split chunk")
		}
		if _, e := c.Ensure(h); e != nil {
			t.Fatal(e)
		}
	}
	data[len(data)-1] ^= 1
	if e := os.WriteFile(filepath.Join(s.Dir, "p", id), data, 0600); e != nil {
		t.Fatal(e)
	}
	bad := New(t.TempDir(), s, 64)
	if e := bad.Pack(ctx, id, hs); e == nil {
		t.Fatal("corruption accepted")
	}
	for _, h := range hs {
		if !bad.Missing(h) {
			t.Fatal("corrupt pack published a chunk")
		}
	}
}
