//go:build !kvm || !camelfs_medium_bundles

package store

import (
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/root"
)

func TestDefaultBundleRejectsMediumMember(t *testing.T) {
	blob := newSmall(make([]byte, (64<<10)+1))
	db := &bundleTestDB{rows: make(map[string]locatorItem)}
	s := ForLineage(WithBundles(Local{Dir: t.TempDir()}, db, "objects"), "default")
	if _, err := PutSmallBlobs(t.Context(), s, []SmallBlob{blob}); err == nil {
		t.Fatal("default publication accepted a blob above 64 KiB")
	}
	ref := BundleRef{Key: "p/" + root.Hash(blob.Data), SHA256: blob.SHA256, Size: int64(len(blob.Data)), PackSize: int64(len(blob.Data))}
	if ValidateBundleRef(ref) {
		t.Fatal("default reader accepted a member above 64 KiB")
	}
}
