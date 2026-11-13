package image

import (
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"sort"
	"strconv"
	"unsafe"
)

func clone(src, dst string) error {
	f, e := os.Open(src)
	if e != nil {
		return e
	}
	defer f.Close()
	g, e := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	ok := false
	defer func() {
		g.Close()
		if !ok {
			os.Remove(dst)
		}
	}()
	if os.Getenv("CAMELFSD_TEST_NO_REFLINK") == "1" {
		_, e = io.Copy(g, f)
	} else {
		e = unix.IoctlFileClone(int(g.Fd()), int(f.Fd()))
	}
	if e == nil {
		e = g.Sync()
	}
	ok = e == nil
	return e
}
func Probe(dir string) error {
	if os.Getenv("CAMELFSD_TEST_NO_REFLINK") == "1" {
		return nil
	}
	f, e := os.CreateTemp(dir, ".probe-")
	if e != nil {
		return e
	}
	p := f.Name()
	defer os.Remove(p)
	defer os.Remove(p + ".clone")
	_, e = f.Write(make([]byte, 4096))
	f.Close()
	if e != nil {
		return e
	}
	if e = clone(p, p+".clone"); e != nil {
		return fmt.Errorf("data requires FICLONE: %w", e)
	}
	return nil
}

type extent struct {
	Logical, Physical, Length uint64
	Reserved                  [2]uint64
	Flags                     uint32
	Reserved2                 [3]uint32
}
type fiemap struct {
	Start, Length                  uint64
	Flags, Mapped, Count, Reserved uint32
	Extents                        [256]extent
}

// extents is replaceable in tests to count FIEMAP calls.
var extents = readExtents

func readExtents(f *os.File) ([]extent, error) {
	var all []extent
	start := uint64(0)
	for {
		m := fiemap{Start: start, Length: ^uint64(0) - start, Flags: 1, Count: 256}
		_, _, errno := unix.Syscall(unix.SYS_IOCTL, f.Fd(), 0xc020660b, uintptr(unsafe.Pointer(&m)))
		if errno != 0 {
			return nil, errno
		}
		if m.Mapped == 0 {
			break
		}
		if m.Mapped > 256 {
			return nil, apierr.Invalid("invalid FIEMAP count")
		}
		all = append(all, m.Extents[:m.Mapped]...)
		last := all[len(all)-1]
		next := last.Logical + last.Length
		if next <= start {
			return nil, fmt.Errorf("FIEMAP made no progress")
		}
		start = next
		if last.Flags&1 != 0 {
			break
		}
	}
	return all, nil
}

// Collect private extents BEFORE reflinking: afterwards the new snapshot itself
// is a sharing partner. Include holes to detect punched-out parent chunks.
func changedRanges(f *os.File, size int64, parent map[string]string) ([]chunk.Range, error) {
	if os.Getenv("CAMELFSD_TEST_NO_REFLINK") == "1" {
		return []chunk.Range{{Offset: 0, Length: size}}, nil
	}
	es, e := extents(f)
	if e != nil {
		return nil, e
	}
	return rangesFromExtents(es, size, parent), nil
}
func rangesFromExtents(es []extent, size int64, parent map[string]string) []chunk.Range {
	var out []chunk.Range
	// Only parent chunks intersecting a hole need to be read to detect deletion.
	offsets := make([]int64, 0, len(parent))
	for key := range parent {
		offset, e := strconv.ParseInt(key, 10, 64)
		if e == nil {
			offsets = append(offsets, offset)
		}
	}
	sort.Slice(offsets, func(i, j int) bool { return offsets[i] < offsets[j] })
	hole := func(start, end int64) {
		i := sort.Search(len(offsets), func(i int) bool { return offsets[i]+root.ChunkSize > start })
		for ; i < len(offsets) && offsets[i] < end; i++ {
			a, b := max(start, offsets[i]), min(end, offsets[i]+root.ChunkSize)
			if b > a {
				out = append(out, chunk.Range{Offset: a, Length: b - a})
			}
		}
	}
	pos := int64(0)
	for _, x := range es {
		a := int64(x.Logical)
		end := min(size, a+int64(x.Length))
		if a > pos {
			hole(pos, a)
		}
		if x.Flags&0x2000 == 0 && end > a {
			out = append(out, chunk.Range{Offset: a, Length: end - a})
		}
		pos = end
	}
	if pos < size {
		hole(pos, size)
	}
	return out
}
