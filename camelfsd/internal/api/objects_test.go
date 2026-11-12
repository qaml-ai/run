package api

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestTreeRoutes(t *testing.T) {
	db, e := refs.Open(filepath.Join(t.TempDir(), "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	s := &Server{Manager: &image.Manager{Refs: db, Store: store.Local{Dir: t.TempDir()}}}
	call := func(method, path string, b []byte, status int) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, bytes.NewReader(b))
		if method == "PUT" {
			req.Header.Set("Content-Length", strconv.Itoa(len(b)))
		}
		s.ServeHTTP(w, req)
		if w.Code != status {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
		return w
	}
	hash := root.Hash([]byte("target"))
	q := func(l, path, mode string) []byte {
		b, _ := json.Marshal(map[string]any{"lineage": l, "files": map[string]any{path: map[string]string{"sha256": hash, "mode": mode}}})
		return b
	}
	call("POST", "/v0/trees", q("l", "link", "120000"), 409)
	w := call("PUT", "/v0/blobs/"+hash+"?lineage=l", []byte("target"), 201)
	var blob map[string]any
	json.Unmarshal(w.Body.Bytes(), &blob)
	call("POST", "/v0/trees", q("other", "link", "120000"), 409)
	call("POST", "/v0/trees", q("l", ".git/x", "100644"), 400)
	call("POST", "/v0/trees", q("l", "link", "160000"), 400)
	w = call("POST", "/v0/trees", q("l", "link", "120000"), 200)
	var result map[string]any
	json.Unmarshal(w.Body.Bytes(), &result)
	tree := result["tree"].(string)
	mount, _ := json.Marshal(map[string]string{"jobId": "unmaterialized", "lineage": "l", "tree": tree})
	w = call("POST", "/v0/mounts", mount, 404)
	if !strings.Contains(w.Body.String(), "no-root-for-tree") {
		t.Fatal(w.Body.String())
	}
	w = call("GET", "/v0/trees/"+tree+"/files/link", nil, 200)
	if w.Body.String() != "target" || w.Header().Get("X-Camelfs-Mode") != "120000" {
		t.Fatal(w)
	}
	call("GET", "/v0/trees/"+tree+"/files/missing", nil, 404)
	call("GET", "/v0/trees/"+tree, nil, 200)
	w = call("GET", "/v0/blobs/"+blob["sha1"].(string), nil, 200)
	if w.Body.String() != "target" {
		t.Fatal(w)
	}
	call("PUT", "/v0/blobs/"+strings.Repeat("a", 64)+"?lineage=l", []byte("x"), 400)
	req := httptest.NewRequest("PUT", "/v0/blobs/"+hash+"?lineage=l", strings.NewReader("target"))
	req.ContentLength = -1
	w = httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
}
