package api

import (
	"context"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"strings"
	"testing"
)

func TestCommitModeChangeUsesTreeSizes(t *testing.T) {
	s := storageServer(t, store.Local{Dir: t.TempDir()})
	repo := s.repository().ForLineage("l")
	ctx := context.Background()
	files := map[string]objects.File{}
	for i := 0; i < 1001; i++ {
		raw := fmt.Sprint(i)
		b, e := repo.Upload(ctx, "l", "", int64(len(raw)), strings.NewReader(raw))
		if e != nil {
			t.Fatal(e)
		}
		files[fmt.Sprintf("file%04d", i)] = objects.File{SHA256: b.SHA256, Mode: "100644"}
	}
	base, e := repo.Import(ctx, objects.Request{Lineage: "l", Files: files})
	if e != nil {
		t.Fatal(e)
	}
	queries := 0
	repo.Query = func(kind string) {
		if kind == "lineage-blobs" {
			queries++
		}
	}
	_, e = makeCommit(ctx, repo, "l", commitRequest{Parents: []string{}, BaseTree: &base.Tree, Author: "a", Changes: []change{{Path: "file0000", Mode: "100755"}}})
	if e != nil {
		t.Fatal(e)
	}
	if queries != 0 {
		t.Fatalf("metadata queries=%d, want none for a mode-only change", queries)
	}
}
