package image

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func exceptionFixture(es []exception) []byte {
	b := make([]byte, 8*snapshotChunk)
	le := binary.LittleEndian
	for i, v := range []uint32{0x70416e53, 1, 1, 1024} {
		le.PutUint32(b[i*4:], v)
	}
	for i, ex := range es {
		le.PutUint64(b[snapshotChunk+int64(i)*16:], ex.Old)
		le.PutUint64(b[snapshotChunk+int64(i)*16+8:], ex.New)
	}
	return b
}
func TestExceptions(t *testing.T) {
	es := []exception{{0, 2}, {3, 3}, {7, 4}}
	b := exceptionFixture(es)
	got, e := readExceptions(bytes.NewReader(b), int64(len(b)), 8*snapshotChunk)
	if e != nil || !reflect.DeepEqual(got, es) {
		t.Fatal(got, e)
	}
	for _, pos := range []int{0, 4, 8, 12} {
		bad := append([]byte(nil), b...)
		bad[pos] ^= 0xff
		if _, e := readExceptions(bytes.NewReader(bad), int64(len(bad)), 8*snapshotChunk); e == nil {
			t.Fatalf("accepted invalid header %d", pos)
		}
	}
	for _, bad := range [][]exception{{{8, 2}}, {{0, 8}}, {{0, 1}}, {{0, 2}, {0, 3}}, {{0, 2}, {1, 2}}} {
		b := exceptionFixture(bad)
		if _, e := readExceptions(bytes.NewReader(b), int64(len(b)), 8*snapshotChunk); e == nil {
			t.Fatal("accepted", bad)
		}
	}
	if _, e := readExceptions(bytes.NewReader(b[:100]), int64(len(b)), 8*snapshotChunk); e == nil {
		t.Fatal("accepted truncated metadata")
	}
}

func TestSnapshotCopy(t *testing.T) {
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "1")
	d := t.TempDir()
	base, cow, dst := filepath.Join(d, "base"), filepath.Join(d, "cow"), filepath.Join(d, "copy")
	b := bytes.Repeat([]byte{7}, int(8*snapshotChunk))
	os.WriteFile(base, b, 0600)
	c := exceptionFixture([]exception{{1, 2}, {5, 3}})
	copy(c[2*snapshotChunk:3*snapshotChunk], bytes.Repeat([]byte{9}, int(snapshotChunk)))
	os.WriteFile(cow, c, 0600)
	ranges, e := snapshotCopy(context.Background(), base, cow, dst, int64(len(b)))
	if e != nil {
		t.Fatal(e)
	}
	copy(b[snapshotChunk:2*snapshotChunk], c[2*snapshotChunk:3*snapshotChunk])
	clear(b[5*snapshotChunk : 6*snapshotChunk])
	got, e := os.ReadFile(dst)
	if e != nil || !bytes.Equal(got, b) || len(ranges) != 2 {
		t.Fatal(ranges, e)
	}
}

// Produce the fixture with the running kernel, never a hand-written substitute.
func TestExceptionsRealSnapshot(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root, dm-snapshot and loop devices")
	}
	for _, tool := range []string{"dmsetup", "losetup"} {
		if _, e := exec.LookPath(tool); e != nil {
			t.Skip(e)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, e := run(ctx, "dmsetup", "version"); e != nil {
		t.Skip(e)
	}
	d := t.TempDir()
	base, cow := filepath.Join(d, "base"), filepath.Join(d, "cow")
	for _, p := range []string{base, cow} {
		f, e := os.Create(p)
		if e != nil {
			t.Fatal(e)
		}
		e = f.Truncate(16 << 20)
		f.Close()
		if e != nil {
			t.Fatal(e)
		}
	}
	origin, e := run(ctx, "losetup", "-f", "--show", base)
	if e != nil {
		t.Skip(e)
	}
	defer run(context.Background(), "losetup", "-d", origin)
	c, e := run(ctx, "losetup", "-f", "--show", cow)
	if e != nil {
		t.Fatal(e)
	}
	defer run(context.Background(), "losetup", "-d", c)
	dm := fmt.Sprintf("camelfsd-test-%d-%d", os.Getpid(), time.Now().UnixNano())
	if _, e = run(ctx, "dmsetup", "create", dm, "--table", fmt.Sprintf("0 %d snapshot %s %s P 1024", (16<<20)/512, origin, c)); e != nil {
		t.Fatal(e)
	}
	defer run(context.Background(), "dmsetup", "remove", dm)
	f, e := os.OpenFile("/dev/mapper/"+dm, os.O_RDWR, 0)
	if e != nil {
		t.Fatal(e)
	}
	for _, off := range []int64{0, 3*snapshotChunk + 4096, 11 * snapshotChunk} {
		if _, e = f.WriteAt(bytes.Repeat([]byte{42}, 4096), off); e != nil {
			t.Fatal(e)
		}
	}
	if e = f.Sync(); e != nil {
		t.Fatal(e)
	}
	f.Close()
	if _, e = run(ctx, "dmsetup", "suspend", dm); e != nil {
		t.Fatal(e)
	}
	defer run(context.Background(), "dmsetup", "resume", dm)
	cf, e := os.Open(cow)
	if e != nil {
		t.Fatal(e)
	}
	defer cf.Close()
	es, e := readExceptions(cf, 16<<20, 16<<20)
	if e != nil {
		t.Fatal(e)
	}
	got := map[uint64]bool{}
	for _, ex := range es {
		got[ex.Old] = true
	}
	if !reflect.DeepEqual(got, map[uint64]bool{0: true, 3: true, 11: true}) || len(es) != 3 {
		t.Fatal(es)
	}
	t.Logf("kernel-produced persistent snapshot fixture: %v", es)
}

func TestMaterializeSparseVirtualSize(t *testing.T) {
	m, _ := unit3(t)
	b := bytes.Repeat([]byte{3}, int(chunk.Size))
	h := root.Hash(b)
	if e := store.ForLineage(m.Store, "l").Put(context.Background(), "c/"+h, b); e != nil {
		t.Fatal(e)
	}
	for _, size := range []int64{1 << 30, 16 << 30} {
		p := filepath.Join(t.TempDir(), "image")
		r := root.Root{VirtualSize: size, Chunks: map[string]string{"0": h, fmt.Sprint(size - chunk.Size): h}}
		if e := m.materialize(context.Background(), "l", r, p); e != nil {
			t.Fatal(e)
		}
		f, e := os.Open(p)
		if e != nil {
			t.Fatal(e)
		}
		st, _ := f.Stat()
		got := make([]byte, chunk.Size)
		_, e = f.ReadAt(got, size-chunk.Size)
		f.Close()
		if e != nil || st.Size() != size || !bytes.Equal(got, b) {
			t.Fatal(st, e)
		}
	}
	if n := m.Cache.Hashes.Load(); n != 1 {
		t.Fatalf("cache refetched duplicate chunk: hashes=%d", n)
	}
}

func TestExceptionsNextMetadataArea(t *testing.T) {
	// A sparse file exercises the 16 GiB area stride without allocating data.
	f, e := os.CreateTemp(t.TempDir(), "areas")
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	const entries = snapshotChunk / 16
	size := (entries + 4) * snapshotChunk
	if e = f.Truncate(size); e != nil {
		t.Fatal(e)
	}
	header := exceptionFixture(nil)[:16]
	f.WriteAt(header, 0)
	area := make([]byte, snapshotChunk)
	for i := int64(0); i < entries; i++ {
		binary.LittleEndian.PutUint64(area[i*16:], uint64(i))
		binary.LittleEndian.PutUint64(area[i*16+8:], uint64(i+2))
	}
	f.WriteAt(area, snapshotChunk)
	clear(area)
	binary.LittleEndian.PutUint64(area, uint64(entries))
	binary.LittleEndian.PutUint64(area[8:], uint64(entries+3))
	f.WriteAt(area, (entries+2)*snapshotChunk)
	es, e := readExceptions(f, size, (entries+1)*snapshotChunk)
	if e != nil || len(es) != int(entries+1) || es[len(es)-1].Old != uint64(entries) {
		t.Fatal(len(es), e)
	}
}
