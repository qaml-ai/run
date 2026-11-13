package image

import (
	"context"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"strings"
	"testing"
)

type storeSpy struct {
	store.Store
	calls int
}

func (s *storeSpy) Get(c context.Context, k string) ([]byte, error) {
	s.calls++
	return s.Store.Get(c, k)
}
func (s *storeSpy) Has(c context.Context, k string) (bool, error) {
	s.calls++
	return s.Store.Has(c, k)
}
func (s *storeSpy) Put(c context.Context, k string, b []byte) error {
	if !strings.HasPrefix(k, "l/k/") {
		s.calls++
	}
	return s.Store.Put(c, k, b)
}
func TestIdenticalCheckpointNoStoreCalls(t *testing.T) {
	m, tr := unit3(t)
	v := mount3(t, m, tr, "j")
	spy := &storeSpy{Store: m.Store}
	m.Store = &store.Uploaded{Store: spy, DB: m.Refs.(*refs.DB).DB}
	first, e := m.Checkpoint(context.Background(), v.JobID)
	if e != nil {
		t.Fatal(e)
	}
	before := spy.calls
	spy.calls = 0
	second, e := m.Checkpoint(context.Background(), v.JobID)
	if e != nil {
		t.Fatal(e)
	}
	if spy.calls != 0 || first.Root != second.Root {
		t.Fatalf("calls=%d roots=%s/%s", spy.calls, first.Root, second.Root)
	}
	t.Logf("checkpoint store calls: first=%d second=%d", before, spy.calls)
}
