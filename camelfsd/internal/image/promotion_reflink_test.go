package image

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

// Set CAMELFSD_XFS_TEST_DIR to an unprivileged writable XFS fixture. This test
// never creates a filesystem or attaches devices.
func TestPromotionSharesImageExtentsXFS(t *testing.T) {
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
	m := &Manager{Config: Config{Data: dir}}
	if e = m.promote(src, "base"); e != nil {
		t.Fatal(e)
	}
	dst := m.image("base")
	g, e := os.Open(dst)
	if e != nil {
		t.Fatal(e)
	}
	defer g.Close()
	a, e := readExtents(f)
	if e != nil {
		t.Fatal(e)
	}
	b, e := readExtents(g)
	if e != nil {
		t.Fatal(e)
	}
	if len(a) == 0 || len(a) != len(b) {
		t.Fatal("different extents")
	}
	for i, x := range a {
		if x.Physical != b[i].Physical || x.Length != b[i].Length || x.Flags&0x2000 == 0 || b[i].Flags&0x2000 == 0 {
			t.Fatal("promotion copied data instead of sharing extents")
		}
	}
	for _, args := range [][]string{{"-B1", src, dst}, {"-B1", "--apparent-size", src, dst}} {
		out, e := exec.Command("du", args...).CombinedOutput()
		if e != nil {
			t.Fatal(e)
		}
		t.Logf("du %v: %s", args, out)
	}
	// Releasing the mount image must leave the promoted inode intact.
	if e = os.Remove(src); e != nil {
		t.Fatal(e)
	}
	got := make([]byte, len(data))
	if _, e = g.ReadAt(got, 0); e != nil || !bytes.Equal(got, data) {
		t.Fatal("promoted data lost", e)
	}
}
