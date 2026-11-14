package chunk

import (
	"bytes"
	"os"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"golang.org/x/sys/unix"
)

func TestDataSkipsSparse64GiBHoles(t *testing.T) {
	f, e := os.CreateTemp(t.TempDir(), "sparse")
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	const size = int64(64<<30) + 512
	if e = f.Truncate(size); e != nil {
		t.Fatal(e)
	}
	// Exercise a chunk boundary, two extents in one chunk, and a partial tail.
	writes := map[int64][]byte{Size - 2: []byte("edge"), 2*Size + 17: []byte("one"), 2*Size + 8192: []byte("two"), size - 3: []byte("end")}
	want := map[int64][]byte{}
	for off, b := range writes {
		if _, e = f.WriteAt(b, off); e != nil {
			t.Fatal(e)
		}
		for i, v := range b {
			at := off + int64(i)
			chunk := at / Size * Size
			if want[chunk] == nil {
				want[chunk] = make([]byte, Size)
			}
			want[chunk][at-chunk] = v
		}
	}
	if e = f.Sync(); e != nil {
		t.Fatal(e)
	}
	if off, e := unix.Seek(int(f.Fd()), 3*Size, unix.SEEK_DATA); e != nil || off <= 3*Size {
		t.Skip("filesystem does not expose sparse extents", off, e)
	}
	count := 0
	e = (Chunker{}).Data(f, size, func(off int64, h string, b []byte) error {
		count++
		if !bytes.Equal(b, want[off]) || h != root.Hash(want[off]) {
			t.Fatalf("unexpected data at %d", off)
		}
		return nil
	})
	if e != nil || count != len(want) {
		t.Fatal(count, len(want), e)
	}
	t.Logf("64 GiB sparse file: hashed %d chunks (%d bytes)", count, int64(count)*Size)
}

func TestDataEmptySparseFile(t *testing.T) {
	f, e := os.CreateTemp(t.TempDir(), "holes")
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	if e = f.Truncate(16 << 30); e != nil {
		t.Fatal(e)
	}
	if e = (Chunker{}).Data(f, 16<<30, func(int64, string, []byte) error { t.Fatal("hashed a hole"); return nil }); e != nil {
		t.Fatal(e)
	}
}
