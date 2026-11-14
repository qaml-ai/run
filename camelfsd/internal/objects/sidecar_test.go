package objects

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type sidecarReads struct {
	store.Store
	mu         sync.Mutex
	root       string
	rootDone   bool
	outOfOrder bool
	childWave  chan struct{}
	active     int
	peak       int
	gets       []string
}

func (s *sidecarReads) Get(ctx context.Context, key string) ([]byte, error) {
	parts := strings.Split(key, "/")
	if len(parts) < 2 || parts[len(parts)-2] != "ts" {
		return s.Store.Get(ctx, key)
	}
	id := parts[len(parts)-1]
	s.mu.Lock()
	s.gets = append(s.gets, id)
	s.active++
	s.peak = max(s.peak, s.active)
	if s.childWave != nil && id != s.root {
		s.outOfOrder = s.outOfOrder || !s.rootDone
		if s.active == 2 {
			select {
			case <-s.childWave:
			default:
				close(s.childWave)
			}
		}
	}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.active--
		if id == s.root {
			s.rootDone = true
		}
		s.mu.Unlock()
	}()
	if s.childWave != nil && id != s.root {
		select {
		case <-s.childWave:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return s.Store.Get(ctx, key)
}

func TestTreeSizeSidecarCache(t *testing.T) {
	ctx := context.Background()
	r := repository(t)
	spy := &sidecarReads{Store: store.Local{Dir: t.TempDir()}}
	r.Store = store.ForLineage(spy, "l")
	blob, err := r.Upload(ctx, "l", "", 3, strings.NewReader("abc"))
	if err != nil {
		t.Fatal(err)
	}
	raw := append([]byte("100644 file\x00"), mustSHA(t, blob.SHA1)...)
	batch := r.BeginPublication()
	id, err := batch.PutObject(ctx, "l", "tree", raw)
	if err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := r.DB.DB.QueryRow("SELECT count(*) FROM tree_sizes WHERE id=?", id).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("before flush: rows=%d err=%v", rows, err)
	}
	if err := batch.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	check := func(wantGets int) {
		t.Helper()
		es, err := r.SizedTree(ctx, id)
		if err != nil || len(es) != 1 || es[0].Size != 3 || len(spy.gets) != wantGets {
			t.Fatalf("entries=%v ts GETs=%d want=%d err=%v", es, len(spy.gets), wantGets, err)
		}
	}
	check(0)
	if _, err := r.DB.DB.Exec("DELETE FROM tree_sizes WHERE id=?", id); err != nil {
		t.Fatal(err)
	}
	check(1)
	check(1)
	var b []byte
	if err := r.DB.DB.QueryRow("SELECT bytes FROM tree_sizes WHERE id=?", id).Scan(&b); err != nil {
		t.Fatal(err)
	}
	if _, err := r.DB.DB.Exec("UPDATE tree_sizes SET bytes=? WHERE id=?", []byte("[]"), id); err != nil {
		t.Fatal(err)
	}
	if _, err := r.SizedTree(ctx, id); err == nil || err.Error() != "corrupt tree sizes" || len(spy.gets) != 1 {
		t.Fatalf("local corruption: ts GETs=%d err=%v", len(spy.gets), err)
	}
	remote := filepath.Join(spy.Store.(store.Local).Dir, "l", "ts", id)
	if err := os.WriteFile(remote, []byte("[]"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := r.DB.DB.Exec("DELETE FROM tree_sizes WHERE id=?", id); err != nil {
		t.Fatal(err)
	}
	if _, err := r.SizedTree(ctx, id); err == nil || err.Error() != "corrupt tree sizes" || len(spy.gets) != 2 {
		t.Fatalf("remote corruption: ts GETs=%d err=%v", len(spy.gets), err)
	}
	unreachable := store.GitHash("tree", nil)
	if _, err := r.DB.DB.Exec("INSERT INTO tree_sizes VALUES(?,?,?)", unreachable, []byte("[]"), 0); err != nil {
		t.Fatal(err)
	}
	if _, err := r.SizedTree(ctx, unreachable); !errors.Is(err, os.ErrNotExist) || len(spy.gets) != 2 {
		t.Fatalf("unreachable tree: ts GETs=%d err=%v", len(spy.gets), err)
	}
	// An identical tree cached from another lineage is also unreachable.
	if _, err := r.DB.DB.Exec("INSERT INTO tree_sizes VALUES(?,?,?)", id, b, 0); err != nil {
		t.Fatal(err)
	}
	other := r.ForLineage("other")
	if _, err := other.SizedTree(ctx, id); !errors.Is(err, os.ErrNotExist) || len(spy.gets) != 2 {
		t.Fatalf("cross-lineage tree: %v", err)
	}
}

func TestTreeEntriesReadsSidecarsByDepth(t *testing.T) {
	ctx := context.Background()
	r := repository(t)
	blob, err := r.Upload(ctx, "l", "", 3, strings.NewReader("abc"))
	if err != nil {
		t.Fatal(err)
	}
	files := make(map[string]File, 10000)
	for dir := 0; dir < 100; dir++ {
		for file := 0; file < 100; file++ {
			// Distinct file names keep all 100 subtree ids distinct.
			path := fmt.Sprintf("dir%02d/file%02d-%02d", dir, dir, file)
			files[path] = File{SHA256: blob.SHA256}
		}
	}
	tree, err := r.Import(ctx, Request{Lineage: "l", Files: files})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.DB.DB.Exec("DELETE FROM tree_sizes"); err != nil {
		t.Fatal(err)
	}
	spy := &sidecarReads{Store: r.Store, root: tree.Tree, childWave: make(chan struct{})}
	r.Store = spy
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	es, err := r.TreeEntries(ctx, tree.Tree)
	if err != nil || len(es) != 10000 {
		t.Fatalf("entries=%d err=%v", len(es), err)
	}
	if len(spy.gets) != 101 || spy.gets[0] != tree.Tree || spy.outOfOrder || spy.peak < 2 || spy.peak > 64 {
		t.Fatalf("ts GETs=%d out-of-order=%v max concurrency=%d", len(spy.gets), spy.outOfOrder, spy.peak)
	}
	for i, entry := range es {
		dir, file := i/100, i%100
		if entry.Path != fmt.Sprintf("dir%02d/file%02d-%02d", dir, dir, file) || entry.Size != 3 {
			t.Fatalf("entry %d: %+v", i, entry)
		}
	}
}
