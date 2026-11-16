package store

import (
	"context"
	"crypto/sha1"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type opener interface {
	Open(context.Context, string) (io.ReadCloser, error)
}

// OpenReader streams a store object without materializing its bytes in memory.
func OpenReader(ctx context.Context, s Store, key string) (io.ReadCloser, error) {
	if v, ok := s.(opener); ok {
		return v.Open(ctx, key)
	}
	return nil, fmt.Errorf("store %T does not support streaming reads", s)
}

// OpenVerifiedBlobFile verifies a blob before any of its bytes are served.
// The returned file is rewound and unlinked. The caller must close it.
func OpenVerifiedBlobFile(ctx context.Context, s Store, dir, id string, size int64) (_ *os.File, err error) {
	if size < 0 {
		return nil, fmt.Errorf("corrupt blob")
	}
	src, err := OpenReader(ctx, s, "o/"+id)
	if err != nil {
		return nil, err
	}
	defer src.Close()
	file, err := os.CreateTemp(dir, "camelfsd-read-")
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			file.Close()
		}
	}()
	// Reclaim the space even if the host exits midway through a large read.
	if err = os.Remove(file.Name()); err != nil {
		return nil, err
	}
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", size)
	reader := blobReadContext{ctx, src}
	n, err := io.Copy(io.MultiWriter(file, h), io.LimitReader(reader, size))
	if err != nil {
		return nil, err
	}
	if n != size {
		return nil, fmt.Errorf("corrupt blob")
	}
	var extra [1]byte
	if _, err = io.ReadFull(reader, extra[:]); err != nil && err != io.EOF {
		return nil, err
	}
	if err != io.EOF || fmt.Sprintf("%x", h.Sum(nil)) != id {
		return nil, fmt.Errorf("corrupt blob")
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return file, nil
}

type blobReadContext struct {
	ctx context.Context
	io.Reader
}

func (r blobReadContext) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(p)
}

func (l Local) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	if !validReadKey(key) {
		return nil, fmt.Errorf("invalid key")
	}
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	f, e := os.Open(filepath.Join(l.Dir, key))
	if e != nil {
		return nil, ioFailure(e)
	}
	return storeReader{f}, nil
}
func (s *Uploaded) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	return OpenReader(ctx, s.Store, key)
}

type leasedReader struct {
	io.ReadCloser
	release func()
}

func (r *leasedReader) Close() error { e := r.ReadCloser.Close(); r.release(); return e }
func (s *limited) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	if e := s.acquire(ctx); e != nil {
		return nil, e
	}
	r, e := OpenReader(ctx, s.Store, key)
	if e != nil {
		s.release(ctx)
		return nil, e
	}
	return &leasedReader{ReadCloser: r, release: func() { s.release(ctx) }}, nil
}
