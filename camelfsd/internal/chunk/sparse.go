package chunk

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// Data hashes only chunks intersecting allocated extents. Missing chunks are
// zero in a new root. Ranges still reads complete, padded chunks at boundaries.
// Filesystems without extent seeking retain the full scan's correct result.
func (c Chunker) Data(f *os.File, size int64, fn func(int64, string, []byte) error) error {
	if size < 0 {
		return fmt.Errorf("invalid image size")
	}
	saved, e := f.Seek(0, 1)
	if e != nil {
		return e
	}
	defer f.Seek(saved, 0)
	var ranges []Range
	for pos := int64(0); pos < size; {
		data, e := unix.Seek(int(f.Fd()), pos, unix.SEEK_DATA)
		if errors.Is(e, unix.ENXIO) {
			break
		}
		if errors.Is(e, unix.EINVAL) || errors.Is(e, unix.EOPNOTSUPP) {
			return c.File(f, size, fn)
		}
		if e != nil {
			return e
		}
		if data >= size {
			break
		}
		end, e := unix.Seek(int(f.Fd()), data, unix.SEEK_HOLE)
		if errors.Is(e, unix.EINVAL) || errors.Is(e, unix.EOPNOTSUPP) {
			return c.File(f, size, fn)
		}
		if e != nil {
			return e
		}
		end = min(end, size)
		if data < pos || end <= data {
			return fmt.Errorf("data extent made no progress")
		}
		ranges = append(ranges, Range{Offset: data, Length: end - data})
		pos = end
	}
	return c.Ranges(f, size, ranges, fn)
}
