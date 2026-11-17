package image

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// The serving unit uses 64 GiB disks even for tiny trees. Exercise the real
// mkfs/store/restore pipeline without the test-only dense reflink substitute.
func TestPrebuilt64GiBProductionShape(t *testing.T) {
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "1")
	data := t.TempDir()
	db, err := refs.Open(filepath.Join(data, "workspace-cache.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	source := store.Local{Dir: t.TempDir()}
	const virtualSize = 64 << 30
	m, err := New(Config{Data: data, VirtualSize: virtualSize, PrebuiltImages: true}, source, db)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	const body = "tiny workspace on the real production disk shape\n"
	tree := prebuiltMountTree(t, m, map[string]string{"file": body})
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	begin := time.Now()
	built, err := m.buildPrebuiltImage(ctx, Request{Lineage: "l", Tree: tree}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if built.descriptor.VirtualSize != virtualSize || built.descriptor.StoredSize >= 64<<20 {
		t.Fatalf("tiny sparse artifact has the wrong shape: %+v", built.descriptor)
	}
	f, err := os.Open(built.compressed)
	if err != nil {
		t.Fatal(err)
	}
	descriptor, err := store.PublishWorkspaceImage(ctx, source, built.descriptor, f)
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("publication: %v %v", err, closeErr)
	}
	path, err := m.fetchPrebuiltImage(ctx, descriptor, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() != virtualSize {
		t.Fatalf("restored size: %v %v", info, err)
	}
	got, err := exec.CommandContext(ctx, "debugfs", "-R", "cat /file", path).Output()
	if err != nil || string(got) != body {
		t.Fatalf("restored canonical bytes: %q %v", got, err)
	}
	t.Logf("64GiB tiny build+publish+restore: %s; artifact=%d bytes", time.Since(begin), descriptor.StoredSize)
}
