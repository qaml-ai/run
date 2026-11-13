package store

import (
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"errors"
	"fmt"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Store interface {
	Head(context.Context, string) (Info, error)
	Get(context.Context, string) ([]byte, error)
	Put(context.Context, string, []byte) error
	Has(context.Context, string) (bool, error)
}
type Local struct{ Dir string }

func valid(k string) bool {
	_, p, h, ok := splitKey(k)
	return ok && ((p == "c" || p == "r") && root.Hex(h, 64) || (p == "o" || p == "t" || p == "k" || p == "ts") && root.Hex(h, 40))
}
func verify(k string, b []byte) error {
	if !valid(k) {
		return fmt.Errorf("invalid key")
	}
	_, p, h, _ := splitKey(k)
	if p == "ts" {
		return VerifyTreeSizes(h, b)
	}
	actual := root.Hash(b)
	if p == "o" || p == "t" || p == "k" {
		kind := "blob"
		if p == "t" {
			kind = "tree"
		}
		if p == "k" {
			kind = "commit"
		}
		actual = GitHash(kind, b)
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
func GitHash(kind string, b []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s %d\x00", kind, len(b))
	h.Write(b)
	return fmt.Sprintf("%x", h.Sum(nil))
}
func BlobKey(b []byte) string { return "o/" + GitHash("blob", b) }

// PutBlobFile publishes an already verified blob without buffering it in memory.
func PutBlobFile(ctx context.Context, s Store, key string, f *os.File, metadata ...string) error {
	switch v := s.(type) {
	case *scoped:
		k, e := v.key(key)
		if e != nil {
			return e
		}
		return PutBlobFile(ctx, v.Store, k, f, metadata...)
	case *Uploaded:
		return v.putFile(ctx, key, f, metadata...)
	case *limited:
		if e := v.acquire(ctx); e != nil {
			return e
		}
		defer v.release(ctx)
		return PutBlobFile(ctx, v.Store, key, f, metadata...)
	}
	_, kind, _, _ := splitKey(key)
	if !valid(key) || kind != "o" {
		return fmt.Errorf("invalid blob key")
	}
	if _, e := f.Seek(0, 0); e != nil {
		return e
	}
	sha := ""
	if len(metadata) > 0 {
		sha = metadata[0]
	}
	if sha == "" {
		h := sha256.New()
		if _, e := io.Copy(h, f); e != nil {
			return e
		}
		sha = fmt.Sprintf("%x", h.Sum(nil))
		if _, e := f.Seek(0, 0); e != nil {
			return e
		}
	}
	st, e := f.Stat()
	if e != nil {
		return e
	}
	switch v := s.(type) {
	case Local:
		if e := writeMetadata(filepath.Join(v.Dir, key), Info{Size: st.Size(), SHA256: sha}); e != nil {
			return ioFailure(e)
		}
		dst := filepath.Join(v.Dir, key)
		if e := os.MkdirAll(filepath.Dir(dst), 0700); e != nil {
			return ioFailure(e)
		}
		tmp, e := os.CreateTemp(filepath.Dir(dst), ".tmp-")
		if e != nil {
			return ioFailure(e)
		}
		defer os.Remove(tmp.Name())
		_, e = io.Copy(tmp, f)
		if e == nil {
			e = tmp.Sync()
		}
		ce := tmp.Close()
		if e == nil {
			e = ce
		}
		if e != nil {
			return ioFailure(e)
		}
		return ioFailure(os.Rename(tmp.Name(), dst))
	case *S3:
		k := v.key(key)
		_, e := v.Client.PutObject(ctx, &s3.PutObjectInput{Bucket: &v.Bucket, Key: &k, Body: f, Metadata: map[string]string{"x-camel-sha256": sha}})
		return ioFailure(e)
	default:
		b, e := io.ReadAll(f)
		if e != nil {
			return e
		}
		return s.Put(ctx, key, b)
	}
}
func (l Local) Get(c context.Context, k string) ([]byte, error) {
	if !valid(k) {
		return nil, fmt.Errorf("invalid key")
	}
	b, e := os.ReadFile(filepath.Join(l.Dir, k))
	return b, ioFailure(e)
}
func (l Local) Has(c context.Context, k string) (bool, error) {
	if !valid(k) {
		return false, fmt.Errorf("invalid key")
	}
	_, e := os.Stat(filepath.Join(l.Dir, k))
	if os.IsNotExist(e) {
		return false, nil
	}
	return e == nil, ioFailure(e)
}
func (l Local) Put(c context.Context, k string, b []byte) error {
	if e := verify(k, b); e != nil {
		return e
	}
	_, kind, _, _ := splitKey(k)
	if kind == "o" {
		if e := writeMetadata(filepath.Join(l.Dir, k), Info{Size: int64(len(b)), SHA256: root.Hash(b)}); e != nil {
			return ioFailure(e)
		}
	}
	return ioFailure(Atomic(filepath.Join(l.Dir, k), b))
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

func Open(ctx context.Context, url, region string, depths ...int) (Store, error) {
	depth := DefaultDepth
	if len(depths) > 0 {
		depth = depths[0]
	}
	if depth < 1 {
		return nil, fmt.Errorf("invalid fetch depth")
	}
	if !strings.HasPrefix(url, "s3://") {
		if !filepath.IsAbs(url) {
			return nil, fmt.Errorf("store must be absolute")
		}
		return WithDepth(Local{url}, depth), nil
	}
	bucket, prefix, _ := strings.Cut(strings.TrimPrefix(url, "s3://"), "/")
	if bucket == "" {
		return nil, fmt.Errorf("empty bucket")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = depth
	transport.MaxIdleConnsPerHost = depth
	transport.MaxConnsPerHost = depth
	transport.DisableKeepAlives = false
	transport.IdleConnTimeout = 5 * time.Minute
	cfg, e := config.LoadDefaultConfig(ctx, config.WithRegion(region), config.WithHTTPClient(&http.Client{Transport: transport}))
	if e != nil {
		return nil, e
	}
	return WithDepth(&S3{s3.NewFromConfig(cfg), bucket, strings.Trim(prefix, "/")}, depth), nil
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
	var missing *types.NoSuchKey
	if errors.As(e, &missing) {
		return nil, ioFailure(os.ErrNotExist)
	}
	if e != nil {
		return nil, ioFailure(e)
	}
	defer o.Body.Close()
	b, e := io.ReadAll(o.Body)
	return b, ioFailure(e)
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
	return e == nil, ioFailure(e)
}
func (s *S3) Put(c context.Context, k string, b []byte) error {
	if e := verify(k, b); e != nil {
		return e
	}
	key := s.key(k)
	input := &s3.PutObjectInput{Bucket: &s.Bucket, Key: &key, Body: bytes.NewReader(b)}
	_, kind, _, _ := splitKey(k)
	if kind == "o" {
		input.Metadata = map[string]string{"x-camel-sha256": root.Hash(b)}
	}
	_, e := s.Client.PutObject(c, input)
	return ioFailure(e)
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
	e := Parallel(ctx, Depth(s), keys, func(h string) error {
		inventory, key := s, "c/"+h
		if scoped, ok := s.(*scoped); ok {
			inventory, key = scoped.Store, fullKey(s, key)
		}
		if uploaded, ok := inventory.(*Uploaded); ok {
			known, e := uploaded.known(ctx, key)
			if e != nil || known {
				return e
			}
		}
		var e error
		if e = s.Put(ctx, "c/"+h, b[h]); e == nil {
			mu.Lock()
			n++
			mu.Unlock()
		}
		return e
	})
	return n, e
}

const DefaultDepth = 64

// One shared budget covers foreground reads, prefetch, hydration and uploads.
type limited struct {
	Store
	slots      chan struct{}
	background chan struct{}
}

// Reuse an existing host budget through wrappers; never create per-mount slots.
func hasDepth(s Store) bool {
	switch v := s.(type) {
	case *limited:
		return true
	case *scoped:
		return hasDepth(v.Store)
	case *Uploaded:
		return hasDepth(v.Store)
	}
	return false
}
func WithDepth(s Store, n int) Store {
	if hasDepth(s) {
		return s
	}
	if n < 1 {
		n = DefaultDepth
	}
	return &limited{Store: s, slots: make(chan struct{}, n), background: make(chan struct{}, max(1, n-min(8, max(1, n/4))))}
}
func Depth(s Store) int {
	if v, ok := s.(*scoped); ok {
		return Depth(v.Store)
	}
	if v, ok := s.(*Uploaded); ok {
		return Depth(v.Store)
	}
	if v, ok := s.(*limited); ok {
		return cap(v.slots)
	}
	return DefaultDepth
}

type backgroundKey struct{}

func IsBackground(ctx context.Context) bool { return ctx.Value(backgroundKey{}) == true }

// Background shares a bounded speculative budget, leaving slots for demand.
func Background(ctx context.Context) context.Context {
	return context.WithValue(ctx, backgroundKey{}, true)
}
func (s *limited) acquire(ctx context.Context) error {
	if ctx.Value(backgroundKey{}) == true {
		select {
		case s.background <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
		select {
		case s.slots <- struct{}{}:
			return nil
		case <-ctx.Done():
			<-s.background
			return ctx.Err()
		}
	}

	select {
	case s.slots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (s *limited) release(ctx context.Context) {
	<-s.slots
	if ctx.Value(backgroundKey{}) == true {
		<-s.background
	}
}
func (s *limited) Get(ctx context.Context, k string) ([]byte, error) {
	if e := s.acquire(ctx); e != nil {
		return nil, e
	}
	defer s.release(ctx)
	return s.Store.Get(ctx, k)
}
func (s *limited) Put(ctx context.Context, k string, b []byte) error {
	if e := s.acquire(ctx); e != nil {
		return e
	}
	defer s.release(ctx)
	return s.Store.Put(ctx, k, b)
}
func (s *limited) Has(ctx context.Context, k string) (bool, error) {
	if e := s.acquire(ctx); e != nil {
		return false, e
	}
	defer s.release(ctx)
	return s.Store.Has(ctx, k)
}

func (s *S3) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	if !valid(key) {
		return nil, fmt.Errorf("invalid key")
	}
	k := s.key(key)
	out, e := s.Client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.Bucket, Key: &k})
	var missing *types.NoSuchKey
	if errors.As(e, &missing) {
		return nil, ioFailure(os.ErrNotExist)
	}
	if e != nil {
		return nil, ioFailure(e)
	}
	return storeReader{out.Body}, nil
}
