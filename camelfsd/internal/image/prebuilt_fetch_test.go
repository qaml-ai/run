package image

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestPrebuiltMountRejectsInvalidPayloadSizeBeforeRanges(t *testing.T) {
	for _, fault := range []string{"max-int64", "missing-payload", "wrong-length"} {
		t.Run(fault, func(t *testing.T) {
			source := store.Local{Dir: t.TempDir()}
			m := prebuiltMountHost(t, source)
			tree, err := m.objects("l").Import(t.Context(), objects.Request{Lineage: "l", Files: map[string]objects.File{}})
			if err != nil {
				t.Fatal(err)
			}
			commit := prebuiltMountCommit(t, m, tree.Tree, "")
			body := []byte("payload with a deliberately false descriptor length")
			sha := root.Hash(body)
			descriptor := store.WorkspaceImage{Format: store.WorkspaceImageFormat, Lineage: "l", Tree: tree.Tree,
				Blob: "w/" + sha, SHA256: sha, RawSHA256: strings.Repeat("d", 64), VirtualSize: m.VirtualSize,
				StoredSize: int64(len(body))}
			if fault != "missing-payload" {
				if err := source.Put(t.Context(), "l/"+descriptor.Blob, body); err != nil {
					t.Fatal(err)
				}
			}
			if fault == "max-int64" {
				descriptor.StoredSize = math.MaxInt64
			} else if fault == "wrong-length" {
				descriptor.StoredSize++
			}
			key, err := store.WorkspaceImageKey("l", tree.Tree, m.VirtualSize)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := json.Marshal(descriptor)
			if err != nil {
				t.Fatal(err)
			}
			if err := source.Put(t.Context(), "l/"+key, raw); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			start := time.Now()
			v, err := m.Mount(ctx, prebuiltMountRequest(fault, tree.Tree, commit))
			if err == nil || v != nil {
				t.Fatalf("invalid payload became a mount: %+v, %v", v, err)
			}
			if ctx.Err() != nil || time.Since(start) >= 5*time.Second {
				t.Fatalf("invalid payload was not rejected promptly: %v", err)
			}
			for _, dir := range []string{"workspace-images", "mounts"} {
				entries, err := os.ReadDir(filepath.Join(m.Data, dir))
				if err != nil || len(entries) != 0 {
					t.Fatalf("failed payload left %s: %v, %v", dir, entries, err)
				}
			}
			spools, err := filepath.Glob(filepath.Join(m.Data, ".prebuilt-*"))
			if err != nil || len(spools) != 0 {
				t.Fatalf("failed payload left spools: %v, %v", spools, err)
			}
			var rows int
			if err := m.Refs.(*refs.DB).DB.QueryRow("SELECT count(*) FROM tree_roots").Scan(&rows); err != nil || rows != 0 {
				t.Fatalf("failed payload published cache rows: %d, %v", rows, err)
			}
		})
	}
}

func TestDecodePrebuiltImageRejectsUnrepresentableStoredSize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "image.img")
	err := decodePrebuiltImage(t.Context(), strings.NewReader(""), store.WorkspaceImage{StoredSize: math.MaxInt64}, path)
	if err == nil || !strings.Contains(err.Error(), "EOF bound") {
		t.Fatalf("unrepresentable length error = %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("unrepresentable length created an image: %v", err)
	}
}
