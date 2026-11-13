package cache

import (
	"bytes"
	"context"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPackSplitAndCorruption(t *testing.T) {
	ctx := context.Background()
	s := store.Local{Dir: t.TempDir()}
	var data []byte
	var hs []string
	for i := 0; i < 16; i++ {
		b := make([]byte, root.ChunkSize)
		b[0] = byte(i + 1)
		hs = append(hs, root.Hash(b))
		data = append(data, b...)
	}
	id := root.PackID(hs)
	if e := s.Put(ctx, "p/"+id, data); e != nil {
		t.Fatal(e)
	}
	c := New(t.TempDir(), s, 64)
	defer c.Close()
	if e := c.Pack(ctx, id, hs); e != nil {
		t.Fatal(e)
	}
	for _, h := range hs {
		if c.Missing(h) {
			t.Fatal("missing split chunk")
		}
		if _, e := c.Ensure(h); e != nil {
			t.Fatal(e)
		}
	}
	data[len(data)-1] ^= 1
	if e := os.WriteFile(filepath.Join(s.Dir, "p", id), data, 0600); e != nil {
		t.Fatal(e)
	}
	bad := New(t.TempDir(), s, 64)
	if e := bad.Pack(ctx, id, hs); e == nil {
		t.Fatal("corruption accepted")
	}
	for _, h := range hs {
		if !bad.Missing(h) {
			t.Fatal("corrupt pack published a chunk")
		}
	}
}

type packGateStore struct {
	store.Store
	started, gate chan struct{}
}

func (s *packGateStore) Get(ctx context.Context, k string) ([]byte, error) {
	if strings.HasPrefix(k, "p/") {
		close(s.started)
		select {
		case <-s.gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return s.Store.Get(ctx, k)
}

type packWaitContext struct {
	context.Context
	waiting chan struct{}
	once    sync.Once
}

func (c *packWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}
func TestDemandJoiningMissingPackFallsBackToChunk(t *testing.T) {
	ctx := context.Background()
	local := store.Local{Dir: t.TempDir()}
	var hs []string
	var wanted []byte
	for i := 0; i < 2; i++ {
		b := make([]byte, root.ChunkSize)
		b[0] = byte(i + 1)
		h := root.Hash(b)
		hs = append(hs, h)
		if i == 0 {
			wanted = b
		}
		if e := local.Put(ctx, "c/"+h, b); e != nil {
			t.Fatal(e)
		}
	}
	// The root still names this pack after its rebuildable tier was deleted.
	s := &packGateStore{Store: local, started: make(chan struct{}), gate: make(chan struct{})}
	c := New(t.TempDir(), s, 64)
	defer c.Close()
	packDone := make(chan error, 1)
	go func() { packDone <- c.Pack(store.Background(ctx), root.PackID(hs), hs) }()
	select {
	case <-s.started:
	case <-time.After(time.Second):
		t.Fatal("pack did not start")
	}
	joined := &packWaitContext{Context: ctx, waiting: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		p, e := c.EnsureContext(joined, hs[0])
		if e == nil {
			var got []byte
			got, e = os.ReadFile(p)
			if e == nil && !bytes.Equal(got, wanted) {
				e = fmt.Errorf("wrong fallback bytes")
			}
		}
		done <- e
	}()
	select {
	case <-joined.waiting:
	case <-time.After(time.Second):
		t.Fatal("demand did not join pack")
	}
	close(s.gate)
	if e := <-packDone; !os.IsNotExist(e) {
		t.Fatal("missing pack did not fail as expected", e)
	}
	select {
	case e := <-done:
		if e != nil {
			t.Fatal("pack failure escaped demand", e)
		}
	case <-time.After(time.Second):
		t.Fatal("chunk fallback stalled")
	}
	if c.Fetches.Load() != 2 || c.Packs.Load() != 0 {
		t.Fatal("wrong fallback counters", c.Fetches.Load(), c.Packs.Load())
	}
}
