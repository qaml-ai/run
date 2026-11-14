package cache

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"golang.org/x/sys/unix"
)

func cloneRange(dst, src *os.File, off int64) error {
	return unix.IoctlFileCloneRange(int(dst.Fd()), &unix.FileCloneRange{Src_fd: int64(src.Fd()), Src_offset: uint64(off), Src_length: uint64(root.ChunkSize)})
}

// Hydrate joins the same hash flight as demand. A fetched chunk is verified by
// ensure before writing the image; only then can its cache entry be published.
func (c *Cache) Hydrate(ctx context.Context, lineage, h string, image *os.File, off, length int64) (int, error) {
	wrote := false
	p, e := c.ensure(ctx, h, store.ForLineage(c.Store, lineage), func(p string, b []byte) error {
		n, e := c.writeAt(image, b[:length], off)
		if e != nil {
			return e
		}
		if int64(n) != length {
			return io.ErrShortWrite
		}
		wrote = true
		// A partial final chunk cannot be cloned as a full verified cache object.
		if length != root.ChunkSize {
			return c.atomic(p, b)
		}
		if e = os.MkdirAll(filepath.Dir(p), 0700); e != nil {
			return e
		}
		f, e := os.CreateTemp(filepath.Dir(p), ".chunk-")
		if e != nil {
			return e
		}
		defer os.Remove(f.Name())
		defer f.Close()
		e = c.cloneRange(f, image, off)
		if e != nil {
			if errors.Is(e, unix.EOPNOTSUPP) || errors.Is(e, unix.ENOTTY) || errors.Is(e, unix.EXDEV) || errors.Is(e, unix.EINVAL) || errors.Is(e, unix.ENOSYS) {
				return c.atomic(p, b)
			}
			return e
		}
		if e = f.Sync(); e != nil {
			return e
		}
		if e = os.Rename(f.Name(), p); e != nil {
			return e
		}
		c.ReflinkedChunks.Add(1)
		return nil
	})
	if e != nil {
		return 0, e
	}
	if wrote {
		return int(length), nil
	}
	b, e := os.ReadFile(p)
	if e != nil {
		return 0, e
	}
	n, e := c.writeAt(image, b[:length], off)
	if e == nil && int64(n) != length {
		e = io.ErrShortWrite
	}
	return n, e
}
