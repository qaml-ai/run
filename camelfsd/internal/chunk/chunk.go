package chunk

import (
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"io"
	"os"
	"sort"
)

const Size = root.ChunkSize

type Range struct{ Offset, Length int64 }
type Chunker struct{}

// Ranges includes zero chunks with an empty hash, so callers can remove old data.
func (Chunker) Ranges(f *os.File, size int64, ranges []Range, fn func(int64, string, []byte) error) error {
	offsets := map[int64]bool{}
	for _, r := range ranges {
		if r.Offset < 0 || r.Length < 0 || r.Offset > size || r.Length > size-r.Offset {
			return fmt.Errorf("invalid range")
		}
		if r.Length == 0 {
			continue
		}
		for o := r.Offset / Size * Size; o < r.Offset+r.Length; o += Size {
			offsets[o] = true
		}
	}
	ordered := make([]int64, 0, len(offsets))
	for o := range offsets {
		ordered = append(ordered, o)
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i] < ordered[j] })
	b := make([]byte, Size)
	for _, o := range ordered {
		clear(b)
		want := min(Size, size-o)
		n, e := f.ReadAt(b[:want], o)
		if e != nil && e != io.EOF {
			return e
		}
		if int64(n) != want {
			return io.ErrUnexpectedEOF
		}
		zero := true
		for _, c := range b {
			if c != 0 {
				zero = false
				break
			}
		}
		h := ""
		if !zero {
			h = root.Hash(b)
		}
		if e := fn(o, h, b); e != nil {
			return e
		}
	}
	return nil
}
func (c Chunker) File(f *os.File, size int64, fn func(int64, string, []byte) error) error {
	return c.Ranges(f, size, []Range{{0, size}}, fn)
}
