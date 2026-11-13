package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"os"
	"path/filepath"
)

type Info struct {
	Size   int64
	SHA256 string
}

func (l Local) Head(ctx context.Context, key string) (Info, error) {
	if !valid(key) {
		return Info{}, fmt.Errorf("invalid key")
	}
	st, e := os.Stat(filepath.Join(l.Dir, key))
	if e != nil {
		return Info{}, ioFailure(e)
	}
	info := Info{Size: st.Size()}
	_, kind, _, _ := splitKey(key)
	if kind == "o" {
		raw, e := os.ReadFile(filepath.Join(l.Dir, key) + ".meta")
		if e != nil {
			return Info{}, ioFailure(e)
		}
		if e = json.Unmarshal(raw, &info); e != nil {
			return Info{}, e
		}
		if info.Size != st.Size() {
			return Info{}, fmt.Errorf("blob metadata size mismatch")
		}
	}
	return info, nil
}
func (s *S3) Head(ctx context.Context, key string) (Info, error) {
	if !valid(key) {
		return Info{}, fmt.Errorf("invalid key")
	}
	k := s.key(key)
	out, e := s.Client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &s.Bucket, Key: &k})
	var nf *types.NotFound
	if errors.As(e, &nf) {
		return Info{}, ioFailure(os.ErrNotExist)
	}
	if e != nil {
		return Info{}, ioFailure(e)
	}
	info := Info{SHA256: out.Metadata["x-camel-sha256"]}
	if out.ContentLength != nil {
		info.Size = *out.ContentLength
	}
	return info, nil
}
func (s *Uploaded) Head(ctx context.Context, key string) (Info, error) { return s.Store.Head(ctx, key) }
func (s *limited) Head(ctx context.Context, key string) (Info, error) {
	if e := s.acquire(ctx); e != nil {
		return Info{}, e
	}
	defer s.release()
	return s.Store.Head(ctx, key)
}
func writeMetadata(path string, info Info) error {
	raw, e := json.Marshal(info)
	if e != nil {
		return e
	}
	return Atomic(path+".meta", raw)
}
