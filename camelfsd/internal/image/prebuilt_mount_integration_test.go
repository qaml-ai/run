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
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/testutil"
)

func prebuiltMountHost(t *testing.T, source store.Store) *Manager {
	t.Helper()
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "1")
	data := t.TempDir()
	db, err := refs.Open(filepath.Join(data, "workspace-cache.db"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := New(Config{Data: data, VirtualSize: 16 << 20, PrebuiltImages: true}, store.WithDepth(source, 64), db)
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close(); db.Close() })
	if _, err := os.Stat(blankImage(data, m.VirtualSize)); !os.IsNotExist(err) {
		t.Fatalf("prebuilt host eagerly created a blank image: %v", err)
	}
	return m
}

func prebuiltMountCommit(t *testing.T, m *Manager, tree, parent string) string {
	t.Helper()
	raw := "tree " + tree + "\n"
	if parent != "" {
		raw += "parent " + parent + "\n"
	}
	raw += "author Agent <agent@example.com> 1 +0000\ncommitter camelfs <camelfs@camelfs> 1 +0000\n\nfixture\n"
	id, err := m.objects("l").PutObject(t.Context(), "l", "commit", []byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func prebuiltMountRequest(job, tree, commit string) Request {
	return Request{JobID: job, Lineage: "l", Tree: tree, Parent: commit,
		Fence: &refs.Fence{Holder: "host:1:" + job, Epoch: 1}}
}

func prebuiltMountTree(t *testing.T, m *Manager, files map[string]string) string {
	t.Helper()
	repo := m.objects("l")
	entries := make(map[string]objects.File, len(files))
	for path, data := range files {
		sha := root.Hash([]byte(data))
		if _, err := repo.Upload(t.Context(), "l", sha, int64(len(data)), bytes.NewBufferString(data)); err != nil {
			t.Fatal(err)
		}
		entries[path] = objects.File{SHA256: sha}
	}
	out, err := repo.Import(t.Context(), objects.Request{Lineage: "l", Files: entries})
	if err != nil {
		t.Fatal(err)
	}
	return out.Tree
}

func prebuiltMountLocalImage(t *testing.T, m *Manager, tree string) string {
	t.Helper()
	if err := blank(m.Config); err != nil {
		t.Fatal(err)
	}
	id := root.Hash([]byte("local fixture " + tree))
	if err := clone(blankImage(m.Data, m.VirtualSize), m.image(id)); err != nil {
		t.Fatal(err)
	}
	if err := m.Refs.RecordTree("l", tree, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestPrebuiltMountValidatesCommitBeforeLocalReuse(t *testing.T) {
	m, tree := unit3(t)
	m.PrebuiltImages = true
	imageID := prebuiltMountLocalImage(t, m, tree)
	valid := prebuiltMountCommit(t, m, tree, "")
	mismatched := prebuiltMountCommit(t, m, strings.Repeat("b", 40), "")
	for _, tc := range []struct {
		name, commit, wantErr string
	}{
		{"valid", valid, ""},
		{"missing", strings.Repeat("a", 40), "is missing"},
		{"mismatched", mismatched, "does not name tree"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v, err := m.Mount(t.Context(), prebuiltMountRequest(tc.name, tree, tc.commit))
			if tc.wantErr != "" {
				if v != nil || err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("mount = %+v, %v; want %q", v, err, tc.wantErr)
				}
				if m.lookup(tc.name) != nil {
					t.Fatal("failed mount retained a reservation")
				}
				if _, err := os.Stat(filepath.Join(m.Data, "mounts", tc.name)); !os.IsNotExist(err) {
					t.Fatalf("failed mount retained files: %v", err)
				}
			} else if err != nil || !v.Warm || v.CachedImage != imageID || v.BaseTree != tree || v.needsBaseline {
				t.Fatalf("exact mount = %+v, %v", v, err)
			}
			m.sweepMu.Lock()
			defer m.sweepMu.Unlock()
			if len(m.pins) != 0 {
				t.Fatalf("mount retained pins: %v", m.pins)
			}
		})
	}
}

func TestPrebuiltMountKeepsSafeLocalCommitAncestor(t *testing.T) {
	m, _ := unit3(t)
	m.PrebuiltImages = true
	baseTree := prebuiltMountTree(t, m, map[string]string{"file": "old"})
	baseCommit := prebuiltMountCommit(t, m, baseTree, "")
	imageID := prebuiltMountLocalImage(t, m, baseTree)
	target := prebuiltMountTree(t, m, map[string]string{"file": "new"})
	commit := prebuiltMountCommit(t, m, target, baseCommit)
	v, err := m.Mount(t.Context(), prebuiltMountRequest("edited", target, commit))
	if err != nil || !v.Warm || v.BaseTree != baseTree || v.CachedImage != imageID || !v.needsBaseline {
		t.Fatalf("ancestor mount = %+v, %v", v, err)
	}
	if v.Parent.Commit != commit || v.Parent.Tree != target {
		t.Fatalf("target version changed: %+v", v.Parent)
	}
}

func TestPrebuiltMountBuildsAndSharesExactImage(t *testing.T) {
	source := store.Local{Dir: t.TempDir()}
	first := prebuiltMountHost(t, source)
	const data = "committed file bytes\n"
	tree := prebuiltMountTree(t, first, map[string]string{"file": data, ".camelfs-tmp-tracked": "tracked temporary leaf\n"})
	commit := prebuiltMountCommit(t, first, tree, "")
	v, err := first.Mount(t.Context(), prebuiltMountRequest("first", tree, commit))
	if err != nil || !v.Warm || v.BaseTree != tree || v.needsBaseline {
		t.Fatalf("producer mount = %+v, %v", v, err)
	}
	descriptor, found, err := store.GetWorkspaceImage(t.Context(), first.Store, "l", tree, first.VirtualSize)
	if err != nil || !found || descriptor.Blob == "" {
		t.Fatalf("shared descriptor = %+v, %v, %v", descriptor, found, err)
	}
	// A hit must use the already verified image rather than rebuilding it from
	// canonical file blobs. The commit and tree metadata remain available.
	if err := os.Remove(filepath.Join(source.Dir, "l", store.BlobKey([]byte(data)))); err != nil {
		t.Fatal(err)
	}
	second := prebuiltMountHost(t, source)
	w, err := second.Mount(t.Context(), prebuiltMountRequest("second", tree, commit))
	if err != nil || !w.Warm || w.BaseTree != tree || w.CachedImage != v.CachedImage || w.needsBaseline {
		t.Fatalf("consumer mount = %+v, %v", w, err)
	}
	contents, err := exec.CommandContext(t.Context(), "debugfs", "-R", "cat /file", w.Dest).Output()
	if err != nil || string(contents) != data {
		t.Fatalf("restored bytes = %q, %v", contents, err)
	}
	if err := second.SessionStreams(t.Context(), w.JobID, filepath.Join(testutil.SocketDir(t), "v"), os.Getuid(), true); err != nil {
		t.Fatal(err)
	}
	if second.lookup(w.JobID).needsBaseline {
		t.Fatal("exact-tree temporary recreation requested a new baseline")
	}
	if err := os.Remove(second.image(w.CachedImage)); err != nil {
		t.Fatal(err)
	}
	reloaded, err := second.Mount(t.Context(), prebuiltMountRequest("evicted", tree, commit))
	if err != nil || !reloaded.Warm || reloaded.BaseTree != tree || reloaded.CachedImage != w.CachedImage || reloaded.needsBaseline {
		t.Fatalf("evicted local image mount = %+v, %v", reloaded, err)
	}
	// A published descriptor with a missing payload is an error, even though
	// the canonical tree remains reachable. It must not trigger another build.
	if err := os.Remove(filepath.Join(source.Dir, "l", descriptor.Blob)); err != nil {
		t.Fatal(err)
	}
	third := prebuiltMountHost(t, source)
	if v, err := third.Mount(t.Context(), prebuiltMountRequest("missing-payload", tree, commit)); v != nil || err == nil {
		t.Fatalf("missing payload mount = %+v, %v", v, err)
	}
	if third.lookup("missing-payload") != nil {
		t.Fatal("failed shared restore retained a mount")
	}
	third.sweepMu.Lock()
	defer third.sweepMu.Unlock()
	if len(third.pins) != 0 {
		t.Fatalf("failed shared restore retained pins: %v", third.pins)
	}
}

func TestPrebuiltMountBuildsExactTreeAfterAPIAddition(t *testing.T) {
	m := prebuiltMountHost(t, store.Local{Dir: t.TempDir()})
	base := prebuiltMountTree(t, m, map[string]string{"file": "old\n"})
	parent := prebuiltMountCommit(t, m, base, "")
	v, err := m.Mount(t.Context(), prebuiltMountRequest("base", base, parent))
	if err != nil {
		t.Fatal(err)
	}
	target := prebuiltMountTree(t, m, map[string]string{"file": "old\n", "added": "new API path\n"})
	commit := prebuiltMountCommit(t, m, target, parent)
	w, err := m.Mount(t.Context(), prebuiltMountRequest("added", target, commit))
	if err != nil || !w.Warm || w.BaseTree != target || w.CachedImage == v.CachedImage || w.needsBaseline {
		t.Fatalf("added-path mount = %+v, %v", w, err)
	}
	contents, err := exec.CommandContext(t.Context(), "debugfs", "-R", "cat /added", w.Dest).Output()
	if err != nil || string(contents) != "new API path\n" {
		t.Fatalf("added path bytes = %q, %v", contents, err)
	}
}
