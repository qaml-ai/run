package store

import (
	"context"
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
	if !valid(key) {
		return nil, fmt.Errorf("invalid key")
	}
	if v, ok := s.(opener); ok {
		return v.Open(ctx, key)
	}
	return nil, fmt.Errorf("store %T does not support streaming reads", s)
}
func (l Local) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	if !valid(key) {
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
		s.release()
		return nil, e
	}
	return &leasedReader{ReadCloser: r, release: s.release}, nil
}
