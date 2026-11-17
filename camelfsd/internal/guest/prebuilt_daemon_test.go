package guest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/testutil"
)

// The guest removes orphan temporary leaves before applying a tree. A clean
// exact image may contain tracked leaves with that prefix, so the host must
// resend them before the guest creates its index.
func TestPrebuiltDaemonRestoresTrackedTemporaryLeaves(t *testing.T) {
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "1")
	data := t.TempDir()
	db, err := refs.Open(filepath.Join(data, "workspace-cache.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	source := store.WithDepth(store.Local{Dir: t.TempDir()}, 64)
	m, err := image.New(image.Config{Data: data, VirtualSize: 16 << 20, PrebuiltImages: true}, source, db)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	repo := (&objects.Repository{DB: db, Store: source}).ForLineage("l")
	files := map[string]objects.File{}
	bodies := map[string]string{
		"normal":                    "ordinary content\n",
		".camelfs-tmp-tracked":      "tracked root leaf\n",
		"dir/.camelfs-tmp-tracked":  "tracked nested leaf\n",
		"dir/.camelfs-tmp-link":     "../normal",
		".camelfs-tmp-dir/ordinary": "tracked directory content\n",
	}
	g := fixture(t)
	g.uds = filepath.Join(testutil.SocketDir(t), "v")
	for path, body := range bodies {
		mode := "100644"
		if path == "dir/.camelfs-tmp-link" {
			mode = "120000"
		}
		blob, err := repo.Upload(t.Context(), "l", "", int64(len(body)), strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		files[path] = objects.File{Mode: mode, SHA256: blob.SHA256}
		full := filepath.Join(g.repo, path)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if mode == "120000" {
			err = os.Symlink(body, full)
		} else {
			err = os.WriteFile(full, []byte(body), 0644)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(g.repo, ".camelfs-tmp-orphan"), []byte("unfinished"), 0600); err != nil {
		t.Fatal(err)
	}
	tree, err := repo.Import(t.Context(), objects.Request{Lineage: "l", Files: files})
	if err != nil {
		t.Fatal(err)
	}
	commit, err := repo.PutObject(t.Context(), "l", "commit", []byte("tree "+tree.Tree+"\n\nfixture\n"))
	if err != nil {
		t.Fatal(err)
	}
	// The guest fixture uses g.repo instead of mounting a disk. The cached
	// regular file supplies the same exact-tree host selection as a real image.
	imageID := root.Hash([]byte("exact temporary-leaf fixture"))
	file, err := os.Create(filepath.Join(data, "workspace-images", imageID+".img"))
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(16 << 20); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordTree("l", tree.Tree, imageID); err != nil {
		t.Fatal(err)
	}
	v, err := m.Mount(t.Context(), image.Request{JobID: "temps", Lineage: "l", Tree: tree.Tree, Parent: commit,
		Fence: &refs.Fence{Holder: "host:1:temps", Epoch: 1}})
	if err != nil || !v.Warm || v.BaseTree != tree.Tree {
		t.Fatalf("exact mount = %+v, %v", v, err)
	}
	if err := m.SessionStreams(t.Context(), "temps", g.uds, os.Getuid(), true); err != nil {
		t.Fatal(err)
	}
	if m.NeedsBaseline("temps") {
		t.Fatal("exact-tree temporary recreation requested a new baseline")
	}
	reply, err := g.apply(t.Context(), request{JobID: "temps", TimeoutMs: 5000})
	if err != nil || reply["files"] != 3 || reply["entries"] != len(bodies) {
		t.Fatalf("apply = %+v, %v", reply, err)
	}
	for path, want := range bodies {
		full := filepath.Join(g.repo, path)
		var body []byte
		if path == "dir/.camelfs-tmp-link" {
			var target string
			target, err = os.Readlink(full)
			body = []byte(target)
		} else {
			body, err = os.ReadFile(full)
		}
		if err != nil || string(body) != want {
			t.Fatalf("tracked %s = %q, %v", path, body, err)
		}
	}
	if _, err := os.Stat(filepath.Join(g.repo, ".camelfs-tmp-orphan")); !os.IsNotExist(err) {
		t.Fatalf("orphan temporary leaf remains: %v", err)
	}
	if g.index == nil || g.index.Tree != tree.Tree || len(g.index.Entries) != len(bodies) {
		t.Fatalf("guest index = %+v", g.index)
	}
}
