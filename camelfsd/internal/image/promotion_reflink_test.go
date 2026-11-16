package image

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

// Set CAMELFSD_XFS_TEST_DIR to an unprivileged writable XFS fixture. This test
// never creates a filesystem or attaches devices.
func TestCachedImageClonesIndependentlyXFS(t *testing.T) {
	base := os.Getenv("CAMELFSD_XFS_TEST_DIR")
	if base == "" {
		base = t.TempDir()
	}
	var fs unix.Statfs_t
	if e := unix.Statfs(base, &fs); e != nil {
		t.Fatal(e)
	}
	if fs.Type != unix.XFS_SUPER_MAGIC {
		t.Skip("requires an XFS reflink fixture")
	}
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "")
	dir, e := os.MkdirTemp(base, "promotion-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(dir)
	if e = Probe(dir); e != nil {
		t.Skip("XFS fixture lacks reflink", e)
	}
	src := filepath.Join(dir, "image.img")
	f, e := os.Create(src)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	data := bytes.Repeat([]byte{0x93}, 1<<20)
	if _, e = f.Write(data); e != nil {
		t.Fatal(e)
	}
	if e = f.Truncate(16 << 20); e != nil {
		t.Fatal(e)
	}
	if e = f.Sync(); e != nil {
		t.Fatal(e)
	}
	snapshot := filepath.Join(dir, "snapshot.img")
	if err := clone(src, snapshot); err != nil {
		t.Fatal(err)
	}
	cached := filepath.Join(dir, "cached.img")
	if err := os.Link(snapshot, cached); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte{0x44}, 0); err != nil {
		t.Fatal(err)
	}
	warm := filepath.Join(dir, "warm.img")
	if err := clone(cached, warm); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(warm, []byte("changed by the new guest"), 0600); err != nil {
		t.Fatal(err)
	}
	g, err := os.Open(cached)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	got := make([]byte, len(data))
	if _, err := g.ReadAt(got, 0); err != nil || !bytes.Equal(got, data) {
		t.Fatal("cached checkpoint changed", err)
	}
}
