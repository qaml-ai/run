package api

import (
	"context"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type gatedPublicationStore struct {
	store.Store
	mu      sync.Mutex
	enabled bool
	started chan string
	release chan struct{}
}

func (s *gatedPublicationStore) Put(ctx context.Context, key string, b []byte) error {
	s.mu.Lock()
	enabled := s.enabled
	s.mu.Unlock()
	if enabled {
		select {
		case s.started <- key:
		case <-ctx.Done():
			return ctx.Err()
		}
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return s.Store.Put(ctx, key, b)
}
func TestCommitPublishesTreesAndCommitTogether(t *testing.T) {
	st := &gatedPublicationStore{Store: store.Local{Dir: t.TempDir()}, started: make(chan string, 32), release: make(chan struct{})}
	s := storageServer(t, st)
	blob := put(t, s, "l", "data")
	st.mu.Lock()
	st.enabled = true
	st.mu.Unlock()
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- callStorage(t, s, "l", "POST", "commits", commitRequest{Parents: []string{}, Author: "a", Changes: []change{{Path: "a/b/c/d/file", Blob: blob}}}, "", 201)
	}()
	var once sync.Once
	unblock := func() { once.Do(func() { close(st.release) }) }
	defer unblock()
	seen := map[string]bool{}
	// Five trees, their size sidecars and one commit must all start before
	// any PUT completes.
	// Authorization cache rows are filled after this durable wave.
	for len(seen) < 11 {
		select {
		case key := <-st.started:
			seen[key] = true
		case <-time.After(3 * time.Second):
			t.Fatalf("only %d of 11 PUTs started", len(seen))
		}
	}
	for key := range seen {
		if strings.HasPrefix(key, "l/t/") && !seen[strings.Replace(key, "l/t/", "l/ts/", 1)] {
			t.Fatalf("tree and size sidecar did not start in the same wave: %s", key)
		}
	}
	hasCommit := false
	for key := range seen {
		if strings.HasPrefix(key, "l/k/") {
			hasCommit = true
		}
	}
	if !hasCommit {
		t.Fatal("commit was deferred until tree uploads completed")
	}
	st.mu.Lock()
	st.enabled = false
	st.mu.Unlock()
	unblock()
	<-done
}
