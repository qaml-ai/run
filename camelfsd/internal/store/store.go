package store

import (
	"bytes"
	"context"
	"crypto/sha1"
	"errors"
	"fmt"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type Store interface {
	Get(context.Context, string) ([]byte, error)
	Put(context.Context, string, []byte) error
	Has(context.Context, string) (bool, error)
}
type Local struct{ Dir string }

func valid(k string) bool {
	p, h, ok := strings.Cut(k, "/")
	return ok && (p == "c" || p == "r") && root.Hex(h, 64) || ok && p == "o" && root.Hex(h, 40)
}
func verify(k string, b []byte) error {
	if !valid(k) {
		return fmt.Errorf("invalid key")
	}
	p, h, _ := strings.Cut(k, "/")
	actual := root.Hash(b)
	if p == "o" {
		actual = fmt.Sprintf("%x", sha1.Sum(b))
	}
	if actual != h {
		return fmt.Errorf("hash mismatch")
	}
	if p == "c" {
		zero := true
		for _, v := range b {
			if v != 0 {
				zero = false
				break
			}
		}
		if zero {
			return fmt.Errorf("zero chunk is a hole")
		}
	}
	if p == "c" && len(b) != int(root.ChunkSize) {
		return fmt.Errorf("invalid chunk size")
	}
	return nil
}
func BlobKey(b []byte) string { return fmt.Sprintf("o/%x", sha1.Sum(b)) }
func (l Local) Get(c context.Context, k string) ([]byte, error) {
	if !valid(k) {
		return nil, fmt.Errorf("invalid key")
	}
	return os.ReadFile(filepath.Join(l.Dir, k))
}
func (l Local) Has(c context.Context, k string) (bool, error) {
	if !valid(k) {
		return false, fmt.Errorf("invalid key")
	}
	_, e := os.Stat(filepath.Join(l.Dir, k))
	if os.IsNotExist(e) {
		return false, nil
	}
	return e == nil, e
}
func (l Local) Put(c context.Context, k string, b []byte) error {
	if e := verify(k, b); e != nil {
		return e
	}
	return Atomic(filepath.Join(l.Dir, k), b)
}
func Atomic(p string, b []byte) error {
	if e := os.MkdirAll(filepath.Dir(p), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(p), ".tmp-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if _, e = f.Write(b); e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	return os.Rename(f.Name(), p)
}

type S3 struct {
	Client         *s3.Client
	Bucket, Prefix string
}

func Open(ctx context.Context, url, region string) (Store, error) {
	if !strings.HasPrefix(url, "s3://") {
		if !filepath.IsAbs(url) {
			return nil, fmt.Errorf("store must be absolute")
		}
		return Local{url}, nil
	}
	bucket, prefix, _ := strings.Cut(strings.TrimPrefix(url, "s3://"), "/")
	if bucket == "" {
		return nil, fmt.Errorf("empty bucket")
	}
	cfg, e := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if e != nil {
		return nil, e
	}
	return &S3{s3.NewFromConfig(cfg), bucket, strings.Trim(prefix, "/")}, nil
}
func (s *S3) key(k string) string {
	if s.Prefix == "" {
		return k
	}
	return s.Prefix + "/" + k
}
func (s *S3) Get(c context.Context, k string) ([]byte, error) {
	if !valid(k) {
		return nil, fmt.Errorf("invalid key")
	}
	key := s.key(k)
	o, e := s.Client.GetObject(c, &s3.GetObjectInput{Bucket: &s.Bucket, Key: &key})
	if e != nil {
		return nil, e
	}
	defer o.Body.Close()
	return io.ReadAll(o.Body)
}
func (s *S3) Has(c context.Context, k string) (bool, error) {
	if !valid(k) {
		return false, fmt.Errorf("invalid key")
	}
	key := s.key(k)
	_, e := s.Client.HeadObject(c, &s3.HeadObjectInput{Bucket: &s.Bucket, Key: &key})
	var nf *types.NotFound
	if errors.As(e, &nf) {
		return false, nil
	}
	return e == nil, e
}
func (s *S3) Put(c context.Context, k string, b []byte) error {
	if e := verify(k, b); e != nil {
		return e
	}
	key := s.key(k)
	_, e := s.Client.PutObject(c, &s3.PutObjectInput{Bucket: &s.Bucket, Key: &key, Body: bytes.NewReader(b)})
	return e
}
func Parallel(ctx context.Context, n int, items []string, fn func(string) error) error {
	if n < 1 {
		n = 1
	}
	jobs := make(chan string)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var first error
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for k := range jobs {
				e := ctx.Err()
				if e == nil {
					e = fn(k)
				}
				if e != nil {
					mu.Lock()
					if first == nil {
						first = e
					}
					mu.Unlock()
				}
			}
		}()
	}
	for _, k := range items {
		jobs <- k
	}
	close(jobs)
	wg.Wait()
	return first
}
func PutChunks(ctx context.Context, s Store, b map[string][]byte) (int, error) {
	keys := make([]string, 0, len(b))
	for k := range b {
		keys = append(keys, k)
	}
	var mu sync.Mutex
	n := 0
	e := Parallel(ctx, 16, keys, func(h string) error {
		ok, e := s.Has(ctx, "c/"+h)
		if e != nil || ok {
			return e
		}
		if e = s.Put(ctx, "c/"+h, b[h]); e == nil {
			mu.Lock()
			n++
			mu.Unlock()
		}
		return e
	})
	return n, e
}
