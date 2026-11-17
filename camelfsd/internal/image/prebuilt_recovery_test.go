package image

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestPrebuiltRecoveryRemovesInterruptedSpools(t *testing.T) {
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "1")
	data, outside := t.TempDir(), t.TempDir()
	spool := filepath.Join(data, ".prebuilt-interrupted")
	cache := filepath.Join(data, "workspace-images", root.Hash([]byte("cached"))+".img")
	preserved := map[string]string{
		cache:                                 "completed cached image",
		filepath.Join(data, ".prebuilt-note"): "unrelated regular file",
		filepath.Join(data, "other", "workspace"): "unrelated directory",
		filepath.Join(outside, "do-not-follow"):   "outside symlink target",
		filepath.Join(spool, "files", "partial"):  "interrupted staging tree",
		filepath.Join(spool, "workspace.ext4"):    "interrupted raw image",
		filepath.Join(spool, "download.gz"):       "interrupted download",
	}
	for path, body := range preserved {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	link := filepath.Join(data, ".prebuilt-link")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	db, err := refs.Open(filepath.Join(data, "workspace-cache.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	m, err := New(Config{Data: data, VirtualSize: 16 << 20, PrebuiltImages: true}, store.Local{Dir: t.TempDir()}, db)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if _, err := os.Stat(spool); !os.IsNotExist(err) {
		t.Fatalf("interrupted spool remains: %v", err)
	}
	for path, want := range preserved {
		if filepath.Dir(path) == spool || filepath.Dir(filepath.Dir(path)) == spool {
			continue
		}
		body, err := os.ReadFile(path)
		if err != nil || string(body) != want {
			t.Fatalf("preserved %s = %q, %v", path, body, err)
		}
	}
	if target, err := os.Readlink(link); err != nil || target != outside {
		t.Fatalf("prefixed symlink changed: %q, %v", target, err)
	}
	if _, err := os.Stat(blankImage(data, m.VirtualSize)); !os.IsNotExist(err) {
		t.Fatalf("prebuilt recovery created a blank image: %v", err)
	}
}
