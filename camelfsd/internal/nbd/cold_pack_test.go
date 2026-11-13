package nbd

import (
	"bytes"
	"context"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type coldPackStore struct {
	store.Store
	demand, pack                                       string
	demandStarted, packStarted, allowDemand, allowPack chan struct{}
	demandOnce, packOnce                               sync.Once
}

func (s *coldPackStore) Get(ctx context.Context, k string) ([]byte, error) {
	var gate chan struct{}
	switch k {
	case s.demand:
		s.demandOnce.Do(func() { close(s.demandStarted) })
		gate = s.allowDemand
	case s.pack:
		s.packOnce.Do(func() { close(s.packStarted) })
		gate = s.allowPack
	}
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return s.Store.Get(ctx, k)
}
func waitCold(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatal("cold fetch stalled")
	}
}

// The harness changes store prefixes but retains refs.db. A pack can contain
// valid bytes even when a stale upload record skipped its individual chunks.
func TestColdDemandRacesRootPackAfterStoreChange(t *testing.T) {
	ctx := context.Background()
	data := t.TempDir()
	db, e := refs.Open(filepath.Join(data, "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	before := &store.Uploaded{Store: store.Local{Dir: filepath.Join(data, "before")}, DB: db.DB}
	r := root.Root{V: 1, FSType: "ext4", VirtualSize: 16 * root.ChunkSize, Chunks: map[string]string{}, Packs: map[string]string{}}
	pending := map[string][]byte{}
	var packed []byte
	for i := 0; i < 16; i++ {
		b := make([]byte, root.ChunkSize)
		b[0] = byte(i + 1)
		h := root.Hash(b)
		pending[h] = b
		r.Chunks[strconv.FormatInt(int64(i)*root.ChunkSize, 10)] = h
		packed = append(packed, b...)
	}
	if _, e = store.PutChunks(ctx, before, pending); e != nil {
		t.Fatal(e)
	}
	// Restart at another namespace, retaining the persistent upload inventory.
	if e = db.Close(); e != nil {
		t.Fatal(e)
	}
	db, e = refs.Open(filepath.Join(data, "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	afterLocal := store.Local{Dir: filepath.Join(data, "after")}
	after := &store.Uploaded{Store: afterLocal, DB: db.DB}
	if _, e = store.PutChunks(ctx, after, pending); e != nil {
		t.Fatal(e)
	}
	id := root.PackID(r.WindowHashes(0))
	r.Packs["0"] = id
	if e = after.Put(ctx, "p/"+id, packed); e != nil {
		t.Fatal(e)
	}
	encoded, e := root.Encode(r)
	if e != nil {
		t.Fatal(e)
	}
	rootID := root.Hash(encoded)
	if e = after.Put(ctx, "r/"+rootID, encoded); e != nil {
		t.Fatal(e)
	}
	// A new cache models daemon B. Demand owns one chunk before root prefetch
	// claims the rest of its window; keep both GETs in flight until they overlap.
	h := r.Chunks["0"]
	gated := &coldPackStore{Store: afterLocal, demand: "c/" + h, pack: "p/" + id, demandStarted: make(chan struct{}), packStarted: make(chan struct{}), allowDemand: make(chan struct{}), allowPack: make(chan struct{})}
	c := cache.New(filepath.Join(data, "fresh-cache"), gated, 64)
	defer c.Close()
	s := &Server{Store: afterLocal, Cache: c, FetchDepth: 64, Packs: true}
	d, e := s.load(rootID)
	if e != nil {
		t.Fatal(e)
	}
	defer d.release()
	defer func() {
		select {
		case <-gated.allowDemand:
		default:
			close(gated.allowDemand)
		}
		select {
		case <-gated.allowPack:
		default:
			close(gated.allowPack)
		}
	}()
	got := make([]byte, 4096)
	done := make(chan error, 1)
	go func() { done <- d.readAt(got, 0) }()
	waitCold(t, gated.demandStarted)
	s.PrefetchRoot(rootID)
	waitCold(t, gated.packStarted)
	close(gated.allowDemand)
	select {
	case e = <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("demand waited for pack")
	}
	if e != nil {
		t.Fatalf("first cold read while pack fetch is in flight: %v", e)
	}
	if !bytes.Equal(got, pending[h][:len(got)]) {
		t.Fatal("wrong demand bytes")
	}
	close(gated.allowPack)
	// A later read can join or hit the pack cache, without another missing GET.
	next := r.Chunks[strconv.FormatInt(root.ChunkSize, 10)]
	if e = d.readAt(got, root.ChunkSize); e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(got, pending[next][:len(got)]) {
		t.Fatal("wrong packed bytes")
	}
	// Restarting in the same namespace must retain upload dedupe.
	same := &store.Uploaded{Store: afterLocal, DB: db.DB}
	n, e := store.PutChunks(ctx, same, pending)
	if e != nil || n != 0 {
		t.Fatal("lost same-store dedupe", n, e)
	}
}
