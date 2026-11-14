package compute

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"hash"
	"io"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

var ErrResultCorrupt = errors.New("VM result integrity check failed")

// ReadResult returns a stream whose integrity is checked at EOF. Callers must
// read to EOF (including a read after the last expected byte) and then close it.
func (c *Controller) ReadResult(ctx context.Context, id string) (io.ReadCloser, int64, error) {
	v, err := c.Get(ctx, id)
	if err != nil {
		return nil, 0, err
	}
	return openResult(ctx, c.Objects, v)
}

func openResult(ctx context.Context, objects store.Store, v VM) (io.ReadCloser, int64, error) {
	if v.Phase != Ended || v.ResultRef == "" || objects == nil {
		return nil, 0, ErrNotFound
	}
	key, ok := store.ResultKey(v.Lineage, v.ID)
	if !ok || v.ResultRef != key || v.ResultBytes < 0 || !root.Hex(v.ResultSha256, 64) {
		return nil, 0, ErrResultCorrupt
	}
	body, err := store.OpenReader(ctx, objects, key)
	if err != nil {
		return nil, 0, err
	}
	return &resultReader{ReadCloser: body, digest: sha256.New(), want: v.ResultSha256, remaining: v.ResultBytes}, v.ResultBytes, nil
}

type resultReader struct {
	io.ReadCloser
	digest    hash.Hash
	want      string
	remaining int64
	terminal  error
}

func (r *resultReader) Read(p []byte) (int, error) {
	if r.terminal != nil {
		return 0, r.terminal
	}
	// Read one extra byte to detect an overlong object, without exposing it.
	if r.remaining < int64(len(p)) {
		p = p[:r.remaining+1]
	}
	n, err := r.ReadCloser.Read(p)
	if int64(n) > r.remaining {
		n = int(r.remaining)
		err = ErrResultCorrupt
	}
	r.remaining -= int64(n)
	_, _ = r.digest.Write(p[:n])
	if errors.Is(err, io.EOF) && (r.remaining != 0 || hex.EncodeToString(r.digest.Sum(nil)) != r.want) {
		err = ErrResultCorrupt
	}
	r.terminal = err
	return n, err
}
