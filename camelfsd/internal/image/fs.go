package image

import (
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"golang.org/x/sys/unix"
	"io"
	"os"
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

func extents(f *os.File) ([]extent, error) {
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
			return nil, fmt.Errorf("invalid FIEMAP count")
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
func changedRanges(f *os.File, size int64) ([]chunk.Range, error) {
	if os.Getenv("CAMELFSD_TEST_NO_REFLINK") == "1" {
		return []chunk.Range{{Offset: 0, Length: size}}, nil
	}
	es, e := extents(f)
	if e != nil {
		return nil, e
	}
	var out []chunk.Range
	pos := int64(0)
	for _, x := range es {
		a := int64(x.Logical)
		end := min(size, a+int64(x.Length))
		if a > pos {
			out = append(out, chunk.Range{Offset: pos, Length: a - pos})
		}
		if x.Flags&0x2000 == 0 && end > a {
			out = append(out, chunk.Range{Offset: a, Length: end - a})
		}
		pos = end
	}
	if pos < size {
		out = append(out, chunk.Range{Offset: pos, Length: size - pos})
	}
	return out, nil
}
