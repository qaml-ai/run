package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type countedStore struct {
	store.Store
	mu   sync.Mutex
	puts int
}

func (s *countedStore) Put(c context.Context, k string, b []byte) error {
	s.mu.Lock()
	s.puts++
	s.mu.Unlock()
	return s.Store.Put(c, k, b)
}
func storageServer(t *testing.T, st store.Store) *Server {
	t.Helper()
	db, e := refs.Open(filepath.Join(t.TempDir(), "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	return &Server{APIToken: "test", Manager: &image.Manager{Refs: db, Store: st, Config: image.Config{Data: t.TempDir()}}}
}
func callStorage(t *testing.T, s *Server, l, method, route string, v any, key string, status int) *httptest.ResponseRecorder {
	t.Helper()
	var raw []byte
	if b, ok := v.([]byte); ok {
		raw = b
	} else if v != nil {
		raw, _ = json.Marshal(v)
	}
	r := httptest.NewRequest(method, "/v1/lineages/"+l+"/"+route, bytes.NewReader(raw))
	r.Header.Set("Authorization", "Bearer test")
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%s %s: %d %s", method, route, w.Code, w.Body.String())
	}
	return w
}
func response(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var v map[string]any
	if e := json.Unmarshal(w.Body.Bytes(), &v); e != nil {
		t.Fatal(e)
	}
	return v
}
func put(t *testing.T, s *Server, l, text string) string {
	return response(t, callStorage(t, s, l, "PUT", "blobs", []byte(text), "", 201))["blob"].(string)
}
func commit(t *testing.T, s *Server, l, base string, changes []change) map[string]any {
	q := commitRequest{Author: "agent:test", Message: "test", Changes: changes}
	now := int64(123)
	q.Time = &now
	if base != "" {
		q.BaseTree = &base
	}
	return response(t, callStorage(t, s, l, "POST", "commits", q, "", 201))
}
func TestStorageRoutesDurabilityAndScoping(t *testing.T) {
	st := &countedStore{Store: store.Local{Dir: t.TempDir()}}
	s := storageServer(t, st)
	r := httptest.NewRecorder()
	s.ServeHTTP(r, httptest.NewRequest("GET", "/v1/lineages/a/trees/no", nil))
	if r.Code != 401 {
		t.Fatal(r.Code)
	}
	blob := put(t, s, "a", "hello\nworld\n")
	callStorage(t, s, "a", "PUT", "blobs", []byte("hello\nworld\n"), "", 200)
	q := commitRequest{Author: "agent:test", Message: "message", Changes: []change{{Path: "src/a.txt", Blob: blob}}, Trailers: map[string]string{"Camel-Run": "r"}}
	now := int64(123)
	q.Time = &now
	first := callStorage(t, s, "a", "POST", "commits", q, "key", 201)
	count := st.puts
	second := callStorage(t, s, "a", "POST", "commits", nil, "key", 201)
	if first.Body.String() != second.Body.String() || st.puts != count {
		t.Fatal("replay wrote objects")
	}
	v := response(t, first)
	tree, id := v["tree"].(string), v["commit"].(string)
	again := response(t, callStorage(t, s, "a", "POST", "commits", q, "", 201))
	if again["commit"] != id {
		t.Fatal("non deterministic commit")
	}
	for _, key := range []string{"t/" + tree, "k/" + id} {
		ok, e := st.Has(context.Background(), key)
		if e != nil || !ok {
			t.Fatal(key, e)
		}
	}
	es, e := s.repository().ReadTree(context.Background(), tree)
	if e != nil {
		t.Fatal(e)
	}
	if ok, _ := st.Has(context.Background(), "t/"+es[0].SHA1); !ok {
		t.Fatal("subtree not durable")
	}
	get := "blobs/" + blob + "?tree=" + tree + "&path=src/a.txt"
	w := callStorage(t, s, "a", "GET", get, nil, "", 200)
	if w.Body.String() != "hello\nworld\n" {
		t.Fatal(w.Body.String())
	}
	req := httptest.NewRequest("GET", "/v1/lineages/a/"+get, nil)
	req.Header.Set("Authorization", "Bearer test")
	req.Header.Set("Range", "bytes=0-4")
	rw := httptest.NewRecorder()
	s.ServeHTTP(rw, req)
	if rw.Code != 206 || rw.Body.String() != "hello" {
		t.Fatal(rw.Code, rw.Body.String())
	}
	callStorage(t, s, "b", "GET", get, nil, "", 404)
	callStorage(t, s, "a", "GET", "blobs/"+strings.Repeat("a", 40)+"?tree="+tree+"&path=src/a.txt", nil, "", 404)
	callStorage(t, s, "b", "GET", "trees/"+tree, nil, "", 404)
	callStorage(t, s, "b", "POST", "commits", commitRequest{Author: "x", BaseTree: &tree}, "", 400)
	other := put(t, s, "b", "private")
	callStorage(t, s, "a", "POST", "commits", commitRequest{Author: "x", Changes: []change{{Path: "x", Blob: other}}}, "", 400)
	callStorage(t, s, "a", "POST", "commits", commitRequest{Author: "x", Parent: &other}, "", 400)
	// A fresh SQLite cache recovers both bytes and authorization from the store.
	fresh := storageServer(t, st)
	callStorage(t, fresh, "a", "GET", "commits/"+id, nil, "", 200)
	callStorage(t, fresh, "a", "GET", get, nil, "", 200)
	callStorage(t, fresh, "a", "PUT", "blobs", []byte("hello\nworld\n"), "", 200)
	callStorage(t, fresh, "a", "GET", "trees/"+tree+"?recursive=1", nil, "", 200)
	parent := id
	child := response(t, callStorage(t, fresh, "a", "POST", "commits", commitRequest{Author: "x", Parent: &parent, Changes: []change{{Path: "src/a.txt", Mode: "100755"}, {Path: "absent", Delete: true}}}, "", 201))
	if child["changed"] != float64(1) {
		t.Fatal(child)
	}
	listing := response(t, callStorage(t, s, "a", "GET", "trees/"+tree, nil, "", 200))
	if listing["entries"].([]any)[0].(map[string]any)["mode"] != "040000" {
		t.Fatal(listing)
	}
	r2 := httptest.NewRequest("PUT", "/v1/lineages/a/blobs", strings.NewReader("bad"))
	r2.Header.Set("Authorization", "Bearer test")
	r2.Header.Set("X-Camel-Sha256", strings.Repeat("a", 64))
	rw = httptest.NewRecorder()
	s.ServeHTTP(rw, r2)
	if rw.Code != 400 || !strings.Contains(rw.Body.String(), "blob_mismatch") {
		t.Fatal(rw.Body.String())
	}
	// Explicit null differs from omitted baseTree when a parent is present.
	empty := response(t, callStorage(t, fresh, "a", "POST", "commits", []byte(fmt.Sprintf(`{"parent":%q,"baseTree":null,"author":"x","message":"empty"}`, id)), "", 201))
	if empty["tree"] != "4b825dc642cb6eb9a060e54bf8d69288fbee4904" {
		t.Fatal(empty)
	}
	callStorage(t, fresh, "b", "PUT", "blobs", []byte("hello\nworld\n"), "fresh-blob", 201)
	n := st.puts
	callStorage(t, fresh, "b", "PUT", "blobs", nil, "fresh-blob", 201)
	if st.puts != n {
		t.Fatal("blob replay wrote")
	}
	// Cache misses verify the content id even for an opaque store implementation.
	_, e = fresh.repository().DB.DB.Exec("DELETE FROM objects")
	if e != nil {
		t.Fatal(e)
	}
	local := st.Store.(store.Local)
	_ = store.Atomic(filepath.Join(local.Dir, "t", tree), []byte("corrupt"))
	callStorage(t, fresh, "a", "GET", "trees/"+tree, nil, "", 500)
}
func TestStorageBatchGrepAndDiff(t *testing.T) {
	s := storageServer(t, store.Local{Dir: t.TempDir()})
	blob := put(t, s, "l", strings.Repeat("hello world\n", 2002))
	binary := put(t, s, "l", "hello\x00world")
	c := commit(t, s, "l", "", []change{{Path: "src/a", Blob: blob}, {Path: "src/b", Blob: binary}, {Path: "other/c", Blob: blob}})
	tree := c["tree"].(string)
	callStorage(t, s, "l", "POST", "read", map[string]any{"tree": tree, "paths": make([]string, 257)}, "", 413)
	callStorage(t, s, "l", "POST", "read", map[string]any{"tree": tree, "paths": []string{"src/a"}, "maxBytes": 1}, "", 413)
	w := callStorage(t, s, "l", "POST", "read", map[string]any{"tree": tree, "paths": []string{"src/a", "missing"}}, "", 200)
	_, params, _ := mime.ParseMediaType(w.Header().Get("Content-Type"))
	mr := multipart.NewReader(w.Body, params["boundary"])
	p, e := mr.NextPart()
	if e != nil || p.Header.Get("X-Camel-Blob") != blob {
		t.Fatal(e)
	}
	raw, _ := io.ReadAll(p)
	if len(raw) == 0 {
		t.Fatal("empty part")
	}
	p, e = mr.NextPart()
	if e != nil || p.Header.Get("X-Camel-Error") != "not_in_tree" {
		t.Fatal(e)
	}
	for _, qs := range []string{"q=hello", "q=h.llo&regex=1", "q=HELLO&ignoreCase=1"} {
		v := response(t, callStorage(t, s, "l", "GET", "grep?tree="+tree+"&"+qs, nil, "", 200))
		if len(v["matches"].([]any)) != 2000 || v["truncated"] != true || v["indexed"] != "scan" {
			t.Fatal(v["truncated"])
		}
	}
	v := response(t, callStorage(t, s, "l", "GET", "grep?tree="+tree+"&q=world&path="+url.QueryEscape("src/*")+"&limit=1&context=1", nil, "", 200))
	if len(v["matches"].([]any)) != 1 {
		t.Fatal(v)
	}
	next := commit(t, s, "l", tree, []change{{Path: "src/a", Mode: "100755"}})["tree"].(string)
	reads := 0
	s.repository() // Observe only tree reads, with unchanged subtrees pruned.
	repo := s.repository()
	repo.Query = func(k string) {
		if k == "tree" {
			reads++
		}
	}
	changes, e := treeDiff(context.Background(), repo, tree, next, "")
	if e != nil || len(changes) != 1 || changes[0].Status != "mode" || reads > 4 {
		t.Fatal(changes, reads, e)
	}
	callStorage(t, s, "l", "GET", "diff?from="+tree+"&to="+next, nil, "", 200)
}
func TestStorageMerge(t *testing.T) {
	for _, tc := range []struct {
		name, base, ours, theirs, reason string
		del, mode                        bool
	}{
		{"clean", "a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n", "", false, false},
		{"both_modified", "a\n", "b\n", "c\n", "both_modified", false, false},
		{"delete_modify", "a\n", "", "b\n", "delete_modify", true, false},
		{"binary", "a\x00", "b\x00", "c\x00", "binary", false, false},
		{"mode", "a", "a", "a", "mode", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := &countedStore{Store: store.Local{Dir: t.TempDir()}}
			s := storageServer(t, st)
			b := put(t, s, "l", tc.base)
			base := commit(t, s, "l", "", []change{{Path: "x", Blob: b}})["tree"].(string)
			var o, th string
			if tc.mode {
				o = commit(t, s, "l", base, []change{{Path: "x", Mode: "100755"}})["tree"].(string)
				th = commit(t, s, "l", base, []change{{Path: "x", Mode: "120000"}})["tree"].(string)
			} else {
				oc := change{Path: "x", Delete: tc.del}
				if !tc.del {
					oc.Blob = put(t, s, "l", tc.ours)
				}
				o = commit(t, s, "l", base, []change{oc})["tree"].(string)
				th = commit(t, s, "l", base, []change{{Path: "x", Blob: put(t, s, "l", tc.theirs)}})["tree"].(string)
			}
			before := st.puts
			status := 200
			if tc.reason != "" {
				status = 409
			}
			w := callStorage(t, s, "l", "POST", "merge", mergeRequest{base, o, th, "merge"}, "", status)
			if tc.reason != "" {
				if !strings.Contains(w.Body.String(), tc.reason) || st.puts != before {
					t.Fatal(w.Body.String(), st.puts, before)
				}
			} else {
				v := response(t, w)
				f, e := s.repository().File(context.Background(), v["tree"].(string), "x")
				if e != nil {
					t.Fatal(e)
				}
				raw, e := blobBytes(context.Background(), s.repository(), "l", f.SHA1)
				if e != nil || string(raw) != "A\nb\nC\n" {
					t.Fatal(string(raw), e)
				}
				callStorage(t, s, "l", "POST", "merge", mergeRequest{base, o, th, "squash"}, "", 200)
			}
		})
	}
}
func TestStorageCapsAndInvalid(t *testing.T) {
	s := storageServer(t, store.Local{Dir: t.TempDir()})
	callStorage(t, s, "l", "POST", "commits", commitRequest{Author: "a", Changes: make([]change, 10001)}, "", 413)
	for _, raw := range []string{`{"author":"a","changes":[{"path":"../x","blob":"x"}]}`, `{"author":"a","time":"bad"}`, `{} {}`} {
		callStorage(t, s, "l", "POST", "commits", []byte(raw), "", 400)
	}
	r := httptest.NewRequest("PUT", "/v1/lineages/l/blobs", nil)
	r.Header.Set("Authorization", "Bearer test")
	r.ContentLength = objects.MaxBlob + 1
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 413 {
		t.Fatal(w.Code)
	}
	_ = fmt.Sprint(s)
}
