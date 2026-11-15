package image

import (
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"

	"golang.org/x/sys/unix"
)

func TestLargeBlankIsSparseAndUsesExtents(t *testing.T) {
	if _, e := exec.LookPath("mkfs.ext4"); e != nil {
		t.Skip(e)
	}
	data := t.TempDir()
	if e := os.Mkdir(filepath.Join(data, "images"), 0700); e != nil {
		t.Fatal(e)
	}
	c := Config{Data: data, VirtualSize: 64 << 30}
	if e := blank(c); e != nil {
		t.Fatal(e)
	}
	p := filepath.Join(data, "images", "blank-68719476736.img")
	var st unix.Stat_t
	if e := unix.Stat(p, &st); e != nil {
		t.Fatal(e)
	}
	if st.Size != 64<<30 || st.Blocks*512 > 32<<20 {
		t.Fatalf("blank size=%d allocated=%d; inode tables should stay sparse", st.Size, st.Blocks*512)
	}
	f, e := os.Open(p)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	super := make([]byte, 1024)
	if _, e = f.ReadAt(super, 1024); e != nil {
		t.Fatal(e)
	}
	incompat := binary.LittleEndian.Uint32(super[0x60:])
	if incompat&0x8000 != 0 || incompat&0x40 == 0 {
		t.Fatalf("need extents without inline_data: features=%x", incompat)
	}
	if _, e := exec.LookPath("debugfs"); e == nil {
		out, e := exec.Command("debugfs", "-R", "stat <8>", p).CombinedOutput()
		if e != nil || !regexp.MustCompile(`\bSize:\s+134217728\b`).Match(out) {
			t.Fatalf("journal should be 128 MiB: %s (%v)", out, e)
		}
	}
	t.Logf("64 GiB blank allocated_bytes=%d", st.Blocks*512)
}
