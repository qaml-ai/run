package store

import (
	"context"
	"fmt"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"io"
	"os"
	"path/filepath"
)

// Range fetches exactly length bytes without downloading the rest of an object.
func Range(ctx context.Context, s Store, key string, offset, length int64) ([]byte, error) {
	if !valid(key) || offset < 0 || length <= 0 {
		return nil, fmt.Errorf("invalid range")
	}
	switch v := s.(type) {
	case *Uploaded:
		return Range(ctx, v.Store, key, offset, length)
	case *limited:
		for {
			child, release, e := v.budget.acquire(ctx)
			if e != nil {
				return nil, e
			}
			if fn, ok := ctx.Value(fetchStartKey{}).(func()); ok {
				fn()
			}
			b, e := Range(child, v.Store, key, offset, length)
			if fn, ok := ctx.Value(fetchFinishKey{}).(func(int64)); ok {
				fn(int64(len(b)))
			}
			preempted := child.Err() != nil && ctx.Err() == nil
			release()
			if preempted && IsBackground(ctx) {
				continue
			}
			return b, e
		}
	case Local:
		f, e := os.Open(filepath.Join(v.Dir, key))
		if e != nil {
			return nil, e
		}
		defer f.Close()
		b := make([]byte, length)
		_, e = f.ReadAt(b, offset)
		return b, e
	case *S3:
		k := v.key(key)
		r := fmt.Sprintf("bytes=%d-%d", offset, offset+length-1)
		o, e := v.Client.GetObject(ctx, &s3.GetObjectInput{Bucket: &v.Bucket, Key: &k, Range: &r})
		if e != nil {
			return nil, e
		}
		defer o.Body.Close()
		b, e := io.ReadAll(io.LimitReader(o.Body, length+1))
		if e == nil && int64(len(b)) != length {
			e = io.ErrUnexpectedEOF
		}
		return b, e
	default:
		if r, ok := s.(interface {
			GetRange(context.Context, string, int64, int64) ([]byte, error)
		}); ok {
			return r.GetRange(ctx, key, offset, length)
		}
		b, e := s.Get(ctx, key)
		if e != nil {
			return nil, e
		}
		if offset > int64(len(b)) || length > int64(len(b))-offset {
			return nil, io.ErrUnexpectedEOF
		}
		return b[offset : offset+length], nil
	}
}

// Size is metadata only; it does not count as a payload GET.
func Size(ctx context.Context, s Store, key string) (int64, error) {
	if !valid(key) {
		return 0, fmt.Errorf("invalid key")
	}
	switch v := s.(type) {
	case *Uploaded:
		return Size(ctx, v.Store, key)
	case *limited:
		child, release, e := v.budget.acquire(ctx)
		if e != nil {
			return 0, e
		}
		defer release()
		return Size(child, v.Store, key)
	case Local:
		st, e := os.Stat(filepath.Join(v.Dir, key))
		if e != nil {
			return 0, e
		}
		return st.Size(), nil
	case *S3:
		k := v.key(key)
		o, e := v.Client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &v.Bucket, Key: &k})
		if e != nil {
			return 0, e
		}
		if o.ContentLength == nil {
			return 0, fmt.Errorf("missing pack size")
		}
		return *o.ContentLength, nil
	default:
		b, e := s.Get(ctx, key)
		return int64(len(b)), e
	}
}
