package image

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb/ddbtest"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/testguest"
	"github.com/qaml-ai/run/camelfsd/internal/testutil"
)

func TestPackedApplySmallBundledParallel(t *testing.T) {
	db, table := ddbtest.Table(t, ddbtest.Schema{
		Keys: []types.KeySchemaElement{
			{AttributeName: aws.String("lineage"), KeyType: types.KeyTypeHash},
			{AttributeName: aws.String("id"), KeyType: types.KeyTypeRange},
		},
		Attributes: []types.AttributeDefinition{
			{AttributeName: aws.String("lineage"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("id"), AttributeType: types.ScalarAttributeTypeS},
		},
	})
	m, _ := unit3(t)
	loose := m.Store
	m.Store = store.WithBundles(loose, db, table)
	m.PackedParallel = true
	ctx := t.Context()
	repo := m.objects("l")
	data := []byte("small prepared workspace\n")
	blob, err := repo.Upload(ctx, "l", sha256Hex(data), int64(len(data)), bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	tree, err := repo.Import(ctx, objects.Request{Lineage: "l", Files: map[string]objects.File{"src/file": {SHA256: blob.SHA256}}})
	if err != nil {
		t.Fatal(err)
	}
	commit, err := repo.PutObject(ctx, "l", "commit", fmt.Appendf(nil, "tree %s\n\nfixture\n", tree.Tree))
	if err != nil {
		t.Fatal(err)
	}
	packed, err := m.PreparePackedApply(ctx, "l", commit, tree.Tree, "plain")
	if err != nil {
		t.Fatal(err)
	}
	if packed.Size > store.BundleMaxBlob {
		t.Fatalf("artifact is not small: %d", packed.Size)
	}
	if present, err := loose.Has(ctx, "l/o/"+packed.Blob); err != nil || present {
		t.Fatalf("packed artifact unexpectedly has loose bytes: %v %v", present, err)
	}
	locs, err := store.LocateBundlesForRestore(ctx, store.ForLineage(m.Store, "l"), []string{packed.Blob})
	if err != nil || len(locs) != 1 {
		t.Fatalf("prepared artifact locator = %v, %v", locs, err)
	}
	m.PackedApply = &packed
	const job = "small-packed"
	if _, err := m.Mount(ctx, Request{JobID: job, Lineage: "l", Tree: tree.Tree, Parent: commit, Fence: &refs.Fence{Holder: "host:1:" + job, Epoch: 1}}); err != nil {
		t.Fatal(err)
	}
	vsock := filepath.Join(testutil.SocketDir(t), "small-packed")
	if err := m.SessionStreams(ctx, job, vsock, os.Getuid(), true); err != nil {
		t.Fatal(err)
	}
	guestDir := t.TempDir()
	if err := testguest.Apply(vsock, job, guestDir, filepath.Join(t.TempDir(), "index")); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(guestDir, "src/file"))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("small packed apply bytes = %q, %v", got, err)
	}
}
