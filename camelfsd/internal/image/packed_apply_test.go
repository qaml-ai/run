package image

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/testguest"
	"github.com/qaml-ai/run/camelfsd/internal/testutil"
)

func TestPackedApplyPrototype(t *testing.T) {
	for _, codec := range []string{"plain", "gzip"} {
		t.Run(codec, func(t *testing.T) {
			m, _ := unit3(t)
			ctx := t.Context()
			repo := m.objects("l")
			data := []byte(strings.Repeat("archived content\n", 1024))
			hash := sha256Hex(data)
			if _, err := repo.Upload(ctx, "l", hash, int64(len(data)), bytes.NewReader(data)); err != nil {
				t.Fatal(err)
			}
			tree, err := repo.Import(ctx, objects.Request{Lineage: "l", Files: map[string]objects.File{"src/file": {SHA256: hash, Mode: "100755"}}})
			if err != nil {
				t.Fatal(err)
			}
			commit, err := repo.PutObject(ctx, "l", "commit", fmt.Appendf(nil, "tree %s\n\nfixture\n", tree.Tree))
			if err != nil {
				t.Fatal(err)
			}
			packed, err := m.PreparePackedApply(ctx, "l", commit, tree.Tree, codec)
			if err != nil {
				t.Fatal(err)
			}
			m.PackedApply = &packed
			job := "packed-" + codec
			v, err := m.Mount(ctx, Request{JobID: job, Lineage: "l", Tree: tree.Tree, Parent: commit, Fence: &refs.Fence{Holder: "host:1:" + job, Epoch: 1}})
			if err != nil {
				t.Fatal(err)
			}
			vsock := filepath.Join(testutil.SocketDir(t), "packed")
			if err := m.SessionStreams(ctx, job, vsock, os.Getuid(), true); err != nil {
				t.Fatal(err)
			}
			guestDir := t.TempDir()
			if err := testguest.Apply(vsock, job, guestDir, filepath.Join(t.TempDir(), "index")); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(filepath.Join(guestDir, "src/file"))
			if err != nil || !bytes.Equal(got, data) {
				t.Fatalf("applied bytes mismatch: %v", err)
			}
			info, err := os.Stat(filepath.Join(guestDir, "src/file"))
			if err != nil || info.Mode().Perm() != 0755 {
				t.Fatalf("applied mode mismatch: %v, %v", info, err)
			}
			for _, fault := range []string{"commit", "tree", "lineage", "encoded-hash", "decoded-hash", "missing", "short", "codec"} {
				t.Run(fault, func(t *testing.T) {
					copy := packed
					m.PackedApply = &copy
					switch fault {
					case "commit":
						copy.Commit = strings.Repeat("a", 40)
					case "tree":
						copy.Tree = strings.Repeat("a", 40)
					case "lineage":
						copy.Lineage = "other"
					case "encoded-hash":
						copy.SHA256 = strings.Repeat("a", 64)
					case "decoded-hash":
						copy.RawSHA256 = strings.Repeat("a", 64)
					case "missing":
						copy.Blob = strings.Repeat("a", 40)
					case "short":
						copy.Size--
					case "codec":
						copy.Codec = "invalid"
					}
					var output bytes.Buffer
					err := m.validatePackedApply(ctx, v)
					if err == nil {
						err = m.replayPackedApply(ctx, &output, "l", tree.Tree)
					}
					if err == nil || output.Len() != 0 {
						t.Fatalf("fault %s served bytes=%d error=%v", fault, output.Len(), err)
					}
				})
			}
			m.PackedApply = &packed
			var again bytes.Buffer
			if err := m.replayPackedApply(ctx, &again, "l", tree.Tree); err != nil || again.Len() != int(packed.RawSize) {
				t.Fatalf("replay after failure: bytes=%d, %v", again.Len(), err)
			}
			if _, err := m.PreparePackedApply(ctx, "l", commit, strings.Repeat("a", 40), codec); err == nil {
				t.Fatal("accepted wrong canonical tree")
			}
			if _, err := store.ForLineage(m.Store, "l").Head(ctx, "o/"+packed.Blob); err != nil {
				t.Fatal(err)
			}
		})
	}
}
