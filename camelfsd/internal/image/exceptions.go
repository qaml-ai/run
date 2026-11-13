package image

import (
	"encoding/binary"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"golang.org/x/sys/unix"
	"io"
	"os"
)

const snapshotChunk = int64(512 << 10)

type exception struct{ Old, New uint64 }

// Linux persistent snapshot v1: header, metadata area, data chunks, next area.
// See drivers/md/dm-snap-persistent.c, area_location and disk_exception.
// Caller must quiesce the snapshot before reading this store.
func readExceptions(r io.ReaderAt, cowSize, originSize int64) ([]exception, error) {
	var hdr [16]byte
	if _, e := r.ReadAt(hdr[:], 0); e != nil {
		return nil, e
	}
	le := binary.LittleEndian
	if le.Uint32(hdr[:]) != 0x70416e53 || le.Uint32(hdr[4:]) != 1 || le.Uint32(hdr[8:]) != 1 || le.Uint32(hdr[12:]) != 1024 {
		return nil, fmt.Errorf("invalid persistent snapshot header")
	}
	const entries = snapshotChunk / 16
	b := make([]byte, snapshotChunk)
	seen := map[uint64]bool{}
	used := map[uint64]bool{}
	var out []exception
	for area := int64(1); area < cowSize/snapshotChunk; area += entries + 1 {
		if _, e := r.ReadAt(b, area*snapshotChunk); e != nil {
			return nil, e
		}
		for i := int64(0); i < entries; i++ {
			old, new := le.Uint64(b[i*16:]), le.Uint64(b[i*16+8:])
			if new == 0 {
				return out, nil
			}
			if old >= uint64((originSize+snapshotChunk-1)/snapshotChunk) || new >= uint64(cowSize/snapshotChunk) || new%(uint64(entries)+1) == 1 || seen[old] || used[new] {
				return nil, fmt.Errorf("invalid snapshot exception")
			}
			seen[old] = true
			used[new] = true
			out = append(out, exception{old, new})
		}
	}
	return nil, fmt.Errorf("unterminated snapshot metadata")
}

// Capture through the exception mapping rather than reading the suspended DM
// device (which queues reads). This produces exactly the snapshot's bytes.
func snapshotCopy(base, cow, dst string, size int64) ([]chunk.Range, error) {
	f, e := os.Open(cow)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return nil, e
	}
	es, e := readExceptions(f, st.Size(), size)
	if e != nil {
		return nil, e
	}
	if e = clone(base, dst); e != nil {
		return nil, e
	}
	out, e := os.OpenFile(dst, os.O_RDWR, 0)
	if e != nil {
		return nil, e
	}
	defer out.Close()
	var ranges []chunk.Range
	b := make([]byte, snapshotChunk)
	for _, ex := range es {
		off := int64(ex.Old) * snapshotChunk
		n := min(snapshotChunk, size-off)
		if _, e = f.ReadAt(b[:n], int64(ex.New)*snapshotChunk); e != nil {
			return nil, e
		}
		// Keep deleted chunks sparse in promoted images.
		for i := int64(0); i < n; i += chunk.Size {
			end := min(n, i+chunk.Size)
			zero := true
			for _, v := range b[i:end] {
				if v != 0 {
					zero = false
					break
				}
			}
			if zero {
				e = unix.Fallocate(int(out.Fd()), unix.FALLOC_FL_PUNCH_HOLE|unix.FALLOC_FL_KEEP_SIZE, off+i, end-i)
			} else {
				_, e = out.WriteAt(b[i:end], off+i)
			}
			if e != nil {
				return nil, e
			}
		}
		ranges = append(ranges, chunk.Range{Offset: off, Length: n})
	}
	return ranges, out.Sync()
}
