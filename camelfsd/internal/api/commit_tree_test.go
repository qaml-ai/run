package api

import (
	"context"
	"fmt"
	"math/rand"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// referenceCommit applies changes to a full listing and passes it to Import.
func referenceCommit(ctx context.Context, r *objects.Repository, l string, q commitRequest) (any, error) {
	r = r.ForLineage(l)
	if q.Parents == nil {
		return nil, invalid("missing field parents")
	}
	parents := append([]string{}, q.Parents...)
	if len(parents) > 2 {
		return nil, invalid("parents: at most 2")
	}
	if len(q.Changes) > 10000 {
		return nil, large("")
	}
	if q.Author == "" || !safeLine(q.Author) {
		return nil, invalid("author: required single line without NUL")
	}
	if strings.ContainsRune(q.Message, 0) {
		return nil, invalid("message: NUL is forbidden")
	}
	base := ""
	for i, parent := range parents {
		if !root.Hex(parent, 40) {
			return nil, bad("unknown_commit")
		}
		if e := require(ctx, r, l, parent, "commit", true); e != nil {
			return nil, e
		}
		if i == 0 {
			c, e := readCommit(ctx, r, parent)
			if e != nil {
				return nil, e
			}
			base = c["tree"].(string)
		}
	}
	if q.BaseTree != nil {
		base = *q.BaseTree
	}
	if base != "" {
		if e := require(ctx, r, l, base, "tree", true, "baseTree"); e != nil {
			return nil, e
		}
	}
	files := map[string]objects.File{}

	if base != "" {
		es, e := r.TreeEntries(ctx, base)
		if e != nil {
			return nil, e
		}
		for _, f := range es {
			b, e := r.BlobInfo(ctx, l, f.SHA1)
			if e != nil {
				return nil, e
			}
			files[f.Path] = objects.File{SHA256: b.SHA256, Mode: f.Mode}
		}
	}
	changed := 0
	var bytes int64
	for _, c := range q.Changes {
		if objects.Path(c.Path) != nil {
			return nil, invalid("invalid path %s", c.Path)
		}
		if c.Mode != "" && c.Mode != "100644" && c.Mode != "100755" && c.Mode != "120000" {
			return nil, invalid("invalid mode %s", c.Mode)
		}
		prev, exists := files[c.Path]
		if c.Delete {
			if c.Blob != "" || c.Mode != "" {
				return nil, invalid("delete: blob and mode must be absent")
			}
			if exists {
				delete(files, c.Path)
				changed++
			}
			continue
		}
		next := prev
		if c.Blob != "" {
			if e := require(ctx, r, l, c.Blob, "blob", true); e != nil {
				return nil, e
			}
			b, e := r.BlobInfo(ctx, l, c.Blob)
			if e != nil {
				return nil, e
			}
			next.SHA256 = b.SHA256
			bytes += b.Size
		} else if !exists {
			return nil, invalid("blob: required for new path %q", c.Path)
		}
		if c.Mode != "" {
			next.Mode = c.Mode
		}
		if next.Mode == "" {
			next.Mode = "100644"
		}
		if next != prev {
			changed++
		}
		files[c.Path] = next
	}
	for k, v := range q.Trailers {
		if k == "" || !safeLine(k) || strings.Contains(k, ":") {
			return nil, invalid("invalid trailer key %s", k)
		}
		if !safeLine(v) {
			return nil, invalid("invalid trailer value %s", k)
		}
	}
	tr, e := r.Import(ctx, objects.Request{Lineage: l, ParentTree: base, Files: files})
	if e != nil {
		return nil, e
	}
	return map[string]any{"tree": tr.Tree, "changed": changed, "bytes": bytes}, nil
}

func TestPathCommitMatchesImport(t *testing.T) {
	repo := storageServer(t, store.Local{Dir: t.TempDir()}).repository().ForLineage("l")
	ctx := t.Context()
	var blobs []objects.Blob
	for _, data := range []string{"", "a", "other", "some content"} {
		b, err := repo.Upload(ctx, "l", "", int64(len(data)), strings.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		blobs = append(blobs, b)
	}

	seed := rand.New(rand.NewSource(13))
	randomPath := func() string {
		var parts []string
		for i := seed.Intn(6); i > 0; i-- {
			parts = append(parts, fmt.Sprintf("dir%d", seed.Intn(4)))
		}
		return strings.Join(append(parts, fmt.Sprintf("f%03d", seed.Intn(400))), "/")
	}
	modes := []string{"100644", "100755", "120000"}
	compare := func(t *testing.T, q commitRequest) {
		t.Helper()
		got, err := makeCommit(ctx, repo, "l", q)
		want, refErr := referenceCommit(ctx, repo, "l", q)
		if err != nil || refErr != nil {
			reply := func(err error) string {
				if err == nil {
					return ""
				}
				w := httptest.NewRecorder()
				storageFail(w, err)
				return fmt.Sprintf("%d %s", w.Code, w.Body)
			}
			if reply(err) != reply(refErr) {
				t.Fatalf("changes=%v: got %v, want %v", q.Changes, err, refErr)
			}
			return
		}
		for k, v := range want.(map[string]any) {
			if got.(map[string]any)[k] != v {
				t.Fatalf("%s: got %v, want %v (changes=%v)", k, got, want, q.Changes)
			}
		}
	}
	for i := range 24 {
		files := map[string]objects.File{}
		var names []string
		count := seed.Intn(2001)
		if i == 0 {
			count = 2000
		}
		for len(files) < count {
			p := randomPath()
			if _, ok := files[p]; !ok {
				names = append(names, p)
			}
			files[p] = objects.File{SHA256: blobs[seed.Intn(len(blobs))].SHA256, Mode: modes[seed.Intn(len(modes))]}
		}
		files["singleton/only"] = objects.File{SHA256: blobs[1].SHA256}
		base, err := repo.Import(ctx, objects.Request{Lineage: "l", Files: files})
		if err != nil {
			t.Fatal(err)
		}
		q := commitRequest{Parents: []string{}, Author: "a", BaseTree: &base.Tree}
		for range seed.Intn(50) {
			path := randomPath()
			if len(names) > 0 && seed.Intn(2) == 0 {
				path = names[seed.Intn(len(names))]
			}
			c := change{Path: path}
			switch seed.Intn(4) {
			case 0:
				c.Delete = true
			case 1:
				c.Mode = modes[seed.Intn(len(modes))]
			default:
				c.Blob = blobs[seed.Intn(len(blobs))].SHA1
			}
			q.Changes = append(q.Changes, c)
		}
		t.Run(fmt.Sprint(i), func(t *testing.T) { compare(t, q) })
	}
	b := blobs[1].SHA1
	base, err := repo.Import(ctx, objects.Request{Lineage: "l", Files: map[string]objects.File{
		"nested/only": {SHA256: blobs[1].SHA256}, "file": {SHA256: blobs[1].SHA256},
	}})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		changes []change
	}{
		{"empty-dirs", []change{{Path: "nested/only", Delete: true}, {Path: "file", Delete: true}}},
		{"replace-dir", []change{{Path: "nested", Blob: b}, {Path: "nested/only", Delete: true}}},
		{"replace-file", []change{{Path: "file/x/y", Blob: b}, {Path: "file", Delete: true}}},
		{"conflict-dir", []change{{Path: "nested", Blob: b}}},
		{"conflict-file", []change{{Path: "file/x", Blob: b}}},
		{"conflict-changes", []change{{Path: "new/x", Blob: b}, {Path: "new", Blob: b}}},
		{"new-nested", []change{{Path: "new/x/y", Blob: b}, {Path: "new/z", Blob: b}}},
		{"no-op", []change{{Path: "nested", Delete: true}, {Path: "file/missing", Delete: true}, {Path: "file", Blob: b}}},
		{"cancel", []change{{Path: "new/x", Blob: b}, {Path: "new/x", Delete: true}}},
		{"invalid-path", []change{{Path: "new/../x", Blob: b}}},
		{"invalid-mode", []change{{Path: "new", Mode: "40000"}}},
		{"delete-blob", []change{{Path: "new", Blob: b, Delete: true}}},
		{"delete-mode", []change{{Path: "new", Mode: "100644", Delete: true}}},
		{"missing-blob", []change{{Path: "new", Mode: "100644"}}},
		{"too-many", make([]change, 10001)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, tree := range []*string{nil, &base.Tree} {
				compare(t, commitRequest{Parents: []string{}, BaseTree: tree, Author: "a", Changes: tc.changes})
			}
		})
	}
}

// Each gate holds a whole expected wave until every operation has arrived.
// In particular, a sidecar GET must start before the matching tree GET returns.
type commitWaveStore struct {
	store.Store
	gets        chan string
	puts        chan string
	readRelease chan struct{}
	putRelease  chan struct{}
	mu          sync.Mutex
}

func (s *commitWaveStore) Get(ctx context.Context, key string) ([]byte, error) {
	s.mu.Lock()
	release := s.readRelease
	s.mu.Unlock()
	if err := waitForWave(ctx, key, s.gets, release); err != nil {
		return nil, err
	}
	return s.Store.Get(ctx, key)
}

func (s *commitWaveStore) Put(ctx context.Context, key string, b []byte) error {
	if err := waitForWave(ctx, key, s.puts, s.putRelease); err != nil {
		return err
	}
	return s.Store.Put(ctx, key, b)
}

func waitForWave(ctx context.Context, key string, started chan<- string, release <-chan struct{}) error {
	select {
	case started <- key:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestCommitReadAndWriteWaves(t *testing.T) {
	st := store.Local{Dir: t.TempDir()}
	r := storageServer(t, st).repository().ForLineage("l")
	ctx := t.Context()
	b, err := r.Upload(ctx, "l", "", 1, strings.NewReader("a"))
	if err != nil {
		t.Fatal(err)
	}
	files := make(map[string]objects.File, 10000)
	for d := range 100 {
		for f := range 100 {
			files[fmt.Sprintf("d%d/f%d-%d", d, d, f)] = objects.File{SHA256: b.SHA256}
		}
	}
	files["d99/x/y/z/deep"] = objects.File{SHA256: b.SHA256}
	base, err := r.Import(ctx, objects.Request{Lineage: "l", Files: files})
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name, path string
		waves      int
	}{
		{"depth-one", "d0/f0-0", 2},
		{"depth-four", "d99/x/y/z/deep", 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ids := []string{base.Tree}
			parts := strings.Split(tc.path, "/")
			for _, part := range parts[:len(parts)-1] {
				es, err := r.ReadTree(ctx, ids[len(ids)-1])
				if err != nil {
					t.Fatal(err)
				}
				for _, e := range es {
					if e.Path == part {
						ids = append(ids, e.SHA1)
						break
					}
				}
			}
			if len(ids) != tc.waves {
				t.Fatal(ids)
			}
			if _, err := r.DB.DB.Exec("DELETE FROM objects; DELETE FROM tree_sizes"); err != nil {
				t.Fatal(err)
			}
			spy := &commitWaveStore{Store: st, gets: make(chan string, 128), puts: make(chan string, 128), readRelease: make(chan struct{}), putRelease: make(chan struct{})}
			repo := *r
			repo.Store = spy
			q := commitRequest{Parents: []string{}, BaseTree: &base.Tree, Author: "a", Changes: []change{{Path: tc.path, Mode: "100755"}}}
			now := int64(1)
			q.Time = &now

			// Use the existing authorization and inventory rows, with cold content caches.
			runCtx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			timing := &commitTiming{}
			runCtx = context.WithValue(runCtx, commitTimingKey{}, timing)
			done := make(chan error, 1)
			go func() {
				_, err := makeCommit(runCtx, &repo, "l", q)
				done <- err
			}()
			take := func(ch <-chan string) string {
				t.Helper()
				select {
				case key := <-ch:
					return key
				case err := <-done:
					t.Fatalf("commit exited early: %v", err)
				case <-runCtx.Done():
					t.Fatal("timed out waiting for concurrent requests")
				}
				return ""
			}
			for _, id := range ids {
				got := []string{take(spy.gets), take(spy.gets)}
				slices.Sort(got)
				want := []string{"l/t/" + id, "l/ts/" + id}
				if !slices.Equal(got, want) {
					t.Fatalf("GET wave = %v, want %v", got, want)
				}
				spy.mu.Lock()
				release := spy.readRelease
				spy.readRelease = make(chan struct{})
				spy.mu.Unlock()
				close(release)
			}
			seen := make(map[string]bool)
			wantKeys := tc.waves*2 + 1
			for range wantKeys {
				seen[take(spy.puts)] = true
			}
			commits := 0
			for key := range seen {
				if strings.HasPrefix(key, "l/k/") {
					commits++
				}
				if strings.HasPrefix(key, "l/t/") && !seen[strings.Replace(key, "l/t/", "l/ts/", 1)] {
					t.Fatalf("missing sidecar PUT for %s", key)
				}
			}
			close(spy.putRelease)
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			if len(seen) != wantKeys || commits != 1 || timing.readWaves != tc.waves || timing.PutKeys != wantKeys {
				t.Fatalf("PUTs=%v timings=%+v", seen, timing)
			}
			// The opaque store wrapper still observes all reads on a warm retry.
			close(spy.readRelease)
			*timing = commitTiming{}
			if _, err := makeCommit(runCtx, &repo, "l", q); err != nil {
				t.Fatal(err)
			}
			if len(spy.gets) != 0 {
				t.Fatalf("warm retry: GETs=%d", len(spy.gets))
			}
		})
	}
}

type commitPrecheckStore struct {
	store.Store
	failedBlob string
}

func (s commitPrecheckStore) Head(ctx context.Context, key string) (store.Info, error) {
	if key == "l/o/"+s.failedBlob {
		return store.Info{}, store.ErrUnavailable
	}
	return s.Store.Head(ctx, key)
}

func TestCommitPrecheckErrorOrder(t *testing.T) {
	missingID := strings.Repeat("1", 40)
	failedBlob := strings.Repeat("2", 40)
	st := commitPrecheckStore{Store: store.Local{Dir: t.TempDir()}, failedBlob: failedBlob}
	r := storageServer(t, st).repository()
	q := commitRequest{
		Parents: []string{missingID}, BaseTree: &missingID, Author: "a",
		Changes: []change{{Path: "a", Blob: missingID}, {Path: "b", Blob: failedBlob}},
	}
	check := func(want string) {
		t.Helper()
		if _, err := makeCommit(t.Context(), r, "l", q); err == nil || err.Error() != want {
			t.Fatalf("commit = %v, want %s", err, want)
		}
	}
	check("unknown_commit")
	q.Parents = []string{}
	check("unknown_tree")
	invalidBase := "bad"
	q.BaseTree = &invalidBase
	check("baseTree: expected a 40-character Git id")
	q.BaseTree = nil
	check("unknown_blob")
	slices.Reverse(q.Changes)
	check(store.ErrUnavailable.Error())
}
