package store

import (
	"context"
	"errors"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"net/http"
	"sync"
	"testing"
)

func TestVerifiedKeys(t *testing.T) {
	s := Local{Dir: t.TempDir()}
	ctx := context.Background()
	b := make([]byte, root.ChunkSize)
	b[0] = 1
	h := root.Hash(b)
	if e := s.Put(ctx, "c/"+h, b); e != nil {
		t.Fatal(e)
	}
	if ok, e := s.Has(ctx, "c/"+h); !ok || e != nil {
		t.Fatal(ok, e)
	}
	b[1] = 2
	if e := s.Put(ctx, "c/"+h, b); e == nil {
		t.Fatal("accepted wrong hash")
	}
	if _, e := s.Get(ctx, "../../etc/passwd"); e == nil {
		t.Fatal("accepted invalid key")
	}
	blob := []byte("blob")
	if e := s.Put(ctx, BlobKey(blob), blob); e != nil {
		t.Fatal(e)
	}
}

func TestFetchDefaultsAndS3Pool(t *testing.T) {
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	s, e := Open(context.Background(), "s3://example/prefix", "us-west-2")
	if e != nil {
		t.Fatal(e)
	}
	if Depth(s) != 64 {
		t.Fatal(Depth(s))
	}
	remote := s.(*limited).Store.(*S3)
	client := remote.Client.Options().HTTPClient.(*http.Client)
	transport := client.Transport.(*http.Transport)
	if transport.MaxIdleConnsPerHost != 64 || transport.MaxConnsPerHost != 64 || transport.DisableKeepAlives {
		t.Fatal(transport)
	}
	custom, e := Open(context.Background(), "s3://example/prefix", "us-west-2", 7)
	if e != nil {
		t.Fatal(e)
	}
	if Depth(custom) != 7 {
		t.Fatal(Depth(custom))
	}
}

type blockedStore struct {
	started chan struct{}
	unblock chan struct{}
}

func (s blockedStore) Get(ctx context.Context, k string) ([]byte, error) {
	s.started <- struct{}{}
	<-s.unblock
	return nil, nil
}
func (s blockedStore) Put(ctx context.Context, k string, b []byte) error {
	s.started <- struct{}{}
	<-s.unblock
	return nil
}
func (s blockedStore) Has(ctx context.Context, k string) (bool, error) {
	s.started <- struct{}{}
	<-s.unblock
	return true, nil
}
func TestSharedFetchBudget(t *testing.T) {
	b := blockedStore{make(chan struct{}, 3), make(chan struct{})}
	s := WithDepth(b, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); s.Get(context.Background(), "one") }()
	go func() { defer wg.Done(); s.Put(context.Background(), "two", nil) }()
	<-b.started
	<-b.started
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := s.Has(ctx, "three"); !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
	close(b.unblock)
	wg.Wait()
	if len(b.started) != 0 {
		t.Fatal("exceeded shared budget")
	}
}
