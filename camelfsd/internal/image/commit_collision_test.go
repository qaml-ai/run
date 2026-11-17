package image

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/testguest"
	"github.com/qaml-ai/run/camelfsd/internal/testutil"
)

func TestRestoreAPIEditOverUntrackedDirectory(t *testing.T) {
	debugfs, err := exec.LookPath("debugfs")
	if err != nil {
		t.Skip("debugfs required")
	}
	m, _ := unit3(t)
	ctx := t.Context()
	const lineage = "l"
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	db, err := refs.OpenStorage(filepath.Join(t.TempDir(), "storage.db"))
	check(err)
	defer db.Close()
	repo := &objects.Repository{DB: db, Store: m.Store, TempDir: t.TempDir()}
	upload := func(content string) objects.File {
		t.Helper()
		raw := []byte(content)
		sha := sha256Hex(raw)
		_, err := repo.Upload(ctx, lineage, sha, int64(len(raw)), bytes.NewReader(raw))
		check(err)
		return objects.File{SHA256: sha}
	}
	commit := func(tree, parent string) string {
		t.Helper()
		headers := "tree " + tree + "\n"
		if parent != "" {
			headers += "parent " + parent + "\n"
		}
		raw := headers + "author Agent <agent@example.com> 1 +0000\ncommitter camelfs <camelfs@example.com> 1 +0000\n\nedit\n"
		id, err := repo.PutObject(ctx, lineage, "commit", []byte(raw))
		check(err)
		return id
	}
	const tracked = "tracked checkpoint bytes\n"
	files := map[string]objects.File{"marker": upload(tracked)}
	base, err := repo.Import(ctx, objects.Request{Lineage: lineage, Files: files})
	check(err)
	parent := commit(base.Tree, "")
	const edited = "new file from Storage API\n"
	files["slot"] = upload(edited)
	target, err := repo.Import(ctx, objects.Request{Lineage: lineage, ParentTree: base.Tree, Files: files})
	check(err)
	version := commit(target.Tree, parent)

	const imageID = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	cached := m.image(imageID)
	check(clone(blankImage(m.Data, m.VirtualSize), cached))
	marker := filepath.Join(t.TempDir(), "marker")
	check(os.WriteFile(marker, []byte(tracked), 0600))
	editDisk := func(command string, write bool, image string) {
		t.Helper()
		args := []string{"-R", command, image}
		if write {
			args = append([]string{"-w"}, args...)
		}
		if out, err := exec.Command(debugfs, args...).CombinedOutput(); err != nil {
			t.Fatalf("debugfs %q: %v: %s", command, err, out)
		}
	}
	// A checkpoint image keeps the empty directory even though Git omits it.
	editDisk("write "+marker+" /marker", true, cached)
	editDisk("mkdir /slot", true, cached)
	if stat, err := exec.Command(debugfs, "-R", "stat /slot", cached).CombinedOutput(); err != nil || !strings.Contains(string(stat), "Type: directory") {
		t.Fatalf("cached collision directory: %v: %s", err, stat)
	}
	check(m.Refs.RecordTree(lineage, base.Tree, imageID))
	v, err := m.Mount(ctx, Request{JobID: "api-edit", Lineage: lineage, Tree: target.Tree, Parent: version,
		Fence: &refs.Fence{Holder: "host:1:api-edit", Epoch: 1}})
	check(err)
	if v.Warm || v.BaseTree != "" {
		t.Fatalf("expected a blank image for the API edit: %+v", v)
	}

	guestDir := t.TempDir()
	editDisk("rdump / "+guestDir, false, v.Image)
	vsock := filepath.Join(testutil.SocketDir(t), "vsock")
	check(m.SessionStreams(ctx, v.JobID, vsock, os.Getuid(), true))
	if err := testguest.Apply(vsock, v.JobID, guestDir, filepath.Join(t.TempDir(), "index")); err != nil {
		t.Fatalf("apply target onto selected image (base=%q): %v", v.BaseTree, err)
	}
	for path, want := range map[string]string{"marker": tracked, "slot": edited} {
		content, err := os.ReadFile(filepath.Join(guestDir, path))
		if err != nil || string(content) != want {
			t.Errorf("%s = %q, want %q: %v", path, content, want, err)
		}
	}
}
