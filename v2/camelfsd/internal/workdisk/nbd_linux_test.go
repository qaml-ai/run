package workdisk

import (
	"bytes"
	"context"
	"os"
	"testing"
)

func TestKernelNBD(t *testing.T) {
	slot := os.Getenv("CAMELFSD_TEST_NBD")
	if slot == "" {
		t.Skip("set CAMELFSD_TEST_NBD to a dedicated Linux NBD device")
	}
	v := &View{chunks: make([]string, 32), dirty: make(map[int]struct{}), scratch: t.TempDir()}
	defer v.Close()
	d, err := v.Attach(context.Background(), []string{slot})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := d.Close(); err != nil {
			t.Error(err)
		}
	}()
	// Populate one chunk directly, then confirm Linux sees it through the block
	// device. A cross-chunk write then goes in the opposite direction.
	initial := bytes.Repeat([]byte{31}, ChunkSize)
	if err := v.Transfer(t.Context(), true, 0, initial); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(d.Path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	buf := make([]byte, ChunkSize)
	if _, err := f.ReadAt(buf, 0); err != nil || !bytes.Equal(buf, initial) {
		t.Fatalf("read from NBD: %v", err)
	}
	want := bytes.Repeat([]byte{127}, 8192)
	offset := int64(ChunkSize - 4096)
	if _, err := f.WriteAt(want, offset); err != nil {
		t.Fatal(err)
	}
	if err := f.Sync(); err != nil {
		t.Fatal(err)
	}
	if err := v.Transfer(t.Context(), false, offset, buf[:len(want)]); err != nil || !bytes.Equal(buf[:len(want)], want) {
		t.Fatalf("write through NBD: %v", err)
	}
}
