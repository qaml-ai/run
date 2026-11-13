package objects

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func repository(t *testing.T) *Repository {
	t.Helper()
	db, e := refs.Open(filepath.Join(t.TempDir(), "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	return &Repository{DB: db, Store: store.Local{Dir: t.TempDir()}, TempDir: t.TempDir()}
}
func TestGitTrees(t *testing.T) {
	r := repository(t)
	ctx := context.Background()
	dir := t.TempDir()
	files := map[string]string{"a/b": "nested", "a-b": "dash", "a.b": "dot", "nested/exec": "execute", "link": "a/b", "plain": "plain"}
	q := Request{Lineage: "l", Files: map[string]File{}}
	for p, b := range files {
		mode := "100644"
		if p == "nested/exec" {
			mode = "100755"
		}
		if p == "link" {
			mode = "120000"
		}
		hash := root.Hash([]byte(b))
		q.Files[p] = File{hash, mode}
		blob, e := r.Upload(ctx, "l", hash, int64(len(b)), strings.NewReader(b))
		if e != nil {
			t.Fatal(e)
		}
		cmd := exec.Command("git", "hash-object", "--stdin")
		cmd.Stdin = strings.NewReader(b)
		out, e := cmd.Output()
		if e != nil {
			t.Fatal(e)
		}
		if strings.TrimSpace(string(out)) != blob.SHA1 {
			t.Fatal("blob differs from git")
		}
		dest := filepath.Join(dir, p)
		os.MkdirAll(filepath.Dir(dest), 0700)
		if mode == "120000" {
			e = os.Symlink(b, dest)
		} else {
			perm := os.FileMode(0644)
			if mode == "100755" {
				perm = 0755
			}
			e = os.WriteFile(dest, []byte(b), perm)
		}
		if e != nil {
			t.Fatal(e)
		}
	}
	os.Mkdir(filepath.Join(dir, "empty"), 0700)
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("%v: %s %v", args, out, e)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "-q")
	git("config", "core.filemode", "true")
	git("add", "-A")
	want := git("write-tree")
	first, e := r.Import(ctx, q)
	if e != nil {
		t.Fatal(e)
	}
	if first.Tree != want {
		t.Fatalf("got %s want git %s", first.Tree, want)
	}
	q.ParentTree = first.Tree
	second, e := r.Import(ctx, q)
	if e != nil {
		t.Fatal(e)
	}
	if second.Tree != want || second.Trees != 0 || first.Trees == 0 {
		t.Fatal(first, second)
	}
	q.Files = map[string]File{"a": q.Files["plain"], "a-b": q.Files["plain"], "a.b": q.Files["plain"]}
	if _, e = r.Import(ctx, q); e != nil {
		t.Fatal(e)
	}
	entries, e := r.Entries(ctx, first.Tree)
	if e != nil || len(entries) != len(files) {
		t.Fatal(entries, e)
	}
	link, e := r.File(ctx, first.Tree, "link")
	if e != nil || link.Mode != "120000" {
		t.Fatal(link, e)
	}
}
func TestMissingValidationAndMismatch(t *testing.T) {
	r := repository(t)
	ctx := context.Background()
	a, b := root.Hash([]byte("a")), root.Hash([]byte("b"))
	q := Request{Lineage: "l", Files: map[string]File{"a": {a, ""}, "b": {b, ""}, "again": {b, ""}}}
	_, e := r.Import(ctx, q)
	var missing *Missing
	if !errors.As(e, &missing) || len(missing.Hashes) != 2 || missing.Hashes[0] > missing.Hashes[1] {
		t.Fatal(e)
	}
	r.Upload(ctx, "other", a, 1, strings.NewReader("a"))
	_, e = r.Import(ctx, q)
	if !errors.As(e, &missing) || len(missing.Hashes) != 2 {
		t.Fatal(e)
	}
	if _, e = r.Upload(ctx, "l", a, 1, strings.NewReader("x")); !errors.Is(e, ErrHash) {
		t.Fatal(e)
	}
	var count int
	r.DB.DB.QueryRow("SELECT count(*) FROM lineage_blobs WHERE lineage='l'").Scan(&count)
	if count != 0 {
		t.Fatal(count)
	}
	has, _ := r.Store.Has(ctx, store.BlobKey([]byte("x")))
	if has {
		t.Fatal("mismatch published")
	}
	r.Upload(ctx, "l", a, 1, strings.NewReader("a"))
	r.Upload(ctx, "l", b, 1, strings.NewReader("b"))
	if _, e = r.Import(ctx, q); e != nil {
		t.Fatal(e)
	}
	for _, p := range []string{".git/x", "nested/.git/x", "/x", "a//b", "a/../b", "a/./b", "a/", "a\x00b", strings.Repeat("x", 4097)} {
		_, e = r.Import(ctx, Request{Lineage: "l", Files: map[string]File{p: {a, ""}}})
		if e == nil {
			t.Fatal(p)
		}
	}
	for _, mode := range []string{"160000", "40000", "777"} {
		_, e = r.Import(ctx, Request{Lineage: "l", Files: map[string]File{"x": {a, mode}}})
		if e == nil {
			t.Fatal(mode)
		}
	}
}
func TestLargeConcurrentTree(t *testing.T) {
	r := repository(t)
	ctx := context.Background()
	b := []byte("x")
	hash := root.Hash(b)
	if _, e := r.Upload(ctx, "l", hash, 1, bytes.NewReader(b)); e != nil {
		t.Fatal(e)
	}
	q := Request{Lineage: "l", Files: map[string]File{}}
	for i := 0; i < 15000; i++ {
		q.Files[fmt.Sprintf("file-%05d", i)] = File{hash, ""}
	}
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, e := r.Import(ctx, q)
			if e != nil {
				t.Error(e)
				return
			}
			entries, e := r.read(ctx, v.Tree)
			if e != nil || len(entries) != 15000 {
				t.Error(len(entries), e)
			}
		}()
	}
	wg.Wait()
	var count int
	r.DB.DB.QueryRow("SELECT count(*) FROM objects WHERE bytes IS NULL").Scan(&count)
	if count != 1 {
		t.Fatal(count)
	}
}
func TestEmptyAndUnknownParent(t *testing.T) {
	r := repository(t)
	q := Request{Lineage: "l", ParentTree: strings.Repeat("a", 40), Files: map[string]File{}}
	v, e := r.Import(context.Background(), q)
	if e != nil {
		t.Fatal(e)
	}
	if v.Tree != "4b825dc642cb6eb9a060e54bf8d69288fbee4904" || v.Trees != 1 {
		t.Fatal(v)
	}
	entries, e := r.Entries(context.Background(), v.Tree)
	if e != nil || len(entries) != 0 {
		t.Fatal(entries, e)
	}
}
func TestMissingCap(t *testing.T) {
	r := repository(t)
	q := Request{Lineage: "l", Files: map[string]File{}}
	for i := 0; i < 10005; i++ {
		q.Files[fmt.Sprint(i)] = File{SHA256: fmt.Sprintf("%064x", i)}
	}
	_, e := r.Import(context.Background(), q)
	var missing *Missing
	if !errors.As(e, &missing) || len(missing.Hashes) != 10000 || missing.Hashes[9999] != fmt.Sprintf("%064x", 9999) {
		t.Fatal(e)
	}
}

func TestEntriesQueryBudget(t *testing.T) {
	r := repository(t)
	ctx := context.Background()
	q := Request{Lineage: "l", Files: map[string]File{}}
	for i := 0; i < 2000; i++ {
		b := []byte(fmt.Sprint(i))
		h := root.Hash(b)
		sha := store.GitHash("blob", b)
		if _, e := r.DB.DB.Exec("INSERT INTO lineage_blobs VALUES(?,?,?,?,0)", "l", h, sha, len(b)); e != nil {
			t.Fatal(e)
		}
		q.Files[fmt.Sprintf("f%04d", i)] = File{SHA256: h}
	}
	tree, e := r.Import(ctx, q)
	if e != nil {
		t.Fatal(e)
	}
	count := 0
	r.Query = func(string) { count++ }
	entries, e := r.Entries(ctx, tree.Tree)
	if e != nil || len(entries) != 2000 || count > 5 {
		t.Fatalf("entries=%d queries=%d error=%v", len(entries), count, e)
	}
	for i, f := range entries {
		if f.Size != int64(len(fmt.Sprint(i))) {
			t.Fatal(f)
		}
	}
	t.Logf("2000 files: %d queries", count)
}

type uploadSpy struct {
	store.Store
	puts, heads int
}

func (s *uploadSpy) Has(context.Context, string) (bool, error) {
	s.heads++
	return false, fmt.Errorf("unexpected HEAD")
}
func (s *uploadSpy) Put(c context.Context, k string, b []byte) error {
	s.puts++
	return s.Store.Put(c, k, b)
}
func TestUploadedPersists(t *testing.T) {
	r := repository(t)
	spy := &uploadSpy{Store: r.Store}
	r.Store = spy
	for i := 0; i < 2; i++ {
		_, e := r.Upload(context.Background(), "l", root.Hash([]byte("x")), 1, strings.NewReader("x"))
		if e != nil {
			t.Fatal(e)
		}
	}
	if spy.puts != 1 || spy.heads != 0 {
		t.Fatalf("puts=%d heads=%d", spy.puts, spy.heads)
	}
}

func TestImportReferencedQueryBudget(t *testing.T) {
	r := repository(t)
	q := Request{Lineage: "l", Files: map[string]File{}}
	for i := 0; i < 5000; i++ {
		h := fmt.Sprintf("%064x", i)
		sha := fmt.Sprintf("%040x", i)
		_, e := r.DB.DB.Exec("INSERT INTO lineage_blobs VALUES(?,?,?,?,0)", "l", h, sha, i)
		if e != nil {
			t.Fatal(e)
		}
		q.Files[fmt.Sprint(i)] = File{SHA256: h}
	}
	count := 0
	r.Query = func(string) { count++ }
	if _, e := r.Import(context.Background(), q); e != nil {
		t.Fatal(e)
	}
	if count != 10 {
		t.Fatalf("queries=%d", count)
	}
	q.Files["missing"] = File{SHA256: strings.Repeat("f", 64)}
	_, e := r.Import(context.Background(), q)
	var missing *Missing
	if !errors.As(e, &missing) || len(missing.Hashes) != 1 {
		t.Fatal(e)
	}
	t.Log("5000 referenced hashes: 10 queries")
}
