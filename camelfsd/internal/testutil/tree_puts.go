package testutil

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// TrackTreePuts enumerates the actual durable writes from any tree-producing
// entry point, including image import and guest checkpoint paths.
func TrackTreePuts(t *testing.T, underlying store.Store) store.Store {
	t.Helper()
	s := &treePuts{Store: underlying, keys: map[string]bool{}}
	t.Cleanup(func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		trees := 0
		for key := range s.keys {
			parts := strings.Split(key, "/")
			if len(parts) != 3 || parts[1] != "t" {
				continue
			}
			trees++
			if !s.keys[parts[0]+"/ts/"+parts[2]] {
				t.Errorf("tree PUT %s has no sidecar PUT", key)
			}
		}
		if trees == 0 {
			t.Error("no tree PUTs exercised")
		}
		t.Logf("tree publication census: %d tree PUTs, each with a sidecar PUT", trees)
	})
	return s
}

type treePuts struct {
	store.Store
	mu   sync.Mutex
	keys map[string]bool
}

func (s *treePuts) Put(ctx context.Context, key string, b []byte) error {
	if e := s.Store.Put(ctx, key, b); e != nil {
		return e
	}
	s.mu.Lock()
	s.keys[key] = true
	s.mu.Unlock()
	return nil
}
