package store

import (
	"errors"
	"fmt"
	"io"
)

// ErrUnavailable identifies failures of store I/O, not validation, SQLite or
// content verification. Preserve the underlying error for missing-object checks.
var ErrUnavailable = errors.New("store unavailable")

func ioFailure(e error) error {
	if e == nil {
		return nil
	}
	return fmt.Errorf("%w: %w", ErrUnavailable, e)
}

type storeReader struct{ io.ReadCloser }

func (r storeReader) Read(p []byte) (int, error) {
	n, e := r.ReadCloser.Read(p)
	if e == io.EOF {
		return n, e
	}
	return n, ioFailure(e)
}
func (r storeReader) Close() error { return ioFailure(r.ReadCloser.Close()) }
