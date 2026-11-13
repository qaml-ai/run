package api

import (
	"bytes"
	"encoding/json"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
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
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestChunkedBlobUploadHTTP(t *testing.T) {
	db, e := refs.Open(filepath.Join(t.TempDir(), "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	data := t.TempDir()
	s := &Server{Manager: &image.Manager{Refs: db, Store: store.Local{Dir: t.TempDir()}, Config: image.Config{Data: data}}}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PUT" && (r.ContentLength != -1 || len(r.TransferEncoding) != 1 || r.TransferEncoding[0] != "chunked") {
			t.Errorf("not chunked: length=%d encoding=%v", r.ContentLength, r.TransferEncoding)
		}
		s.ServeHTTP(w, r)
	}))
	defer ts.Close()
	for _, payload := range []string{"hello chunked blob", ""} {
		// Hide the reader's length so net/http sends an actual chunked request.
		req, e := http.NewRequest("PUT", ts.URL+"/v0/blobs/"+root.Hash([]byte(payload))+"?lineage=chunked", io.LimitReader(strings.NewReader(payload), int64(len(payload))))
		if e != nil {
			t.Fatal(e)
		}
		req.ContentLength = -1
		resp, e := ts.Client().Do(req)
		if e != nil {
			t.Fatal(e)
		}
		var blob objects.Blob
		e = json.NewDecoder(resp.Body).Decode(&blob)
		resp.Body.Close()
		if e != nil || resp.StatusCode != 201 || blob.Size != int64(len(payload)) || blob.SHA1 != store.GitHash("blob", []byte(payload)) {
			t.Fatal(resp.StatusCode, blob, e)
		}
		resp, e = ts.Client().Get(ts.URL + "/v0/blobs/" + blob.SHA1)
		if e != nil {
			t.Fatal(e)
		}
		got, e := io.ReadAll(resp.Body)
		resp.Body.Close()
		if e != nil || resp.StatusCode != 200 || string(got) != payload {
			t.Fatal(resp.StatusCode, string(got), e)
		}
	}
	entries, e := os.ReadDir(data)
	if e != nil || len(entries) != 0 {
		t.Fatal("temporary upload files remain", entries, e)
	}
}

type zeroBlobReader struct{}

func (zeroBlobReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }
func TestBlobUploadLengthAndCap(t *testing.T) {
	db, e := refs.Open(filepath.Join(t.TempDir(), "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	data, storage := t.TempDir(), t.TempDir()
	s := &Server{Manager: &image.Manager{Refs: db, Store: store.Local{Dir: storage}, Config: image.Config{Data: data}}}
	for _, tc := range []struct {
		name   string
		size   int64
		body   io.Reader
		status int
	}{
		{"explicit exact", 3, strings.NewReader("abc"), 201},
		{"explicit short", 4, strings.NewReader("abc"), 400},
		{"explicit long", 2, strings.NewReader("abc"), 400},
		{"explicit over cap", objects.MaxBlob + 1, strings.NewReader(""), 413},
		{"chunked over cap", -1, io.LimitReader(zeroBlobReader{}, objects.MaxBlob+1), 413},
		{"chunked bad hash", -1, strings.NewReader("wrong"), 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("PUT", "/v0/blobs/"+root.Hash([]byte("abc"))+"?lineage=l", tc.body)
			req.ContentLength = tc.size
			if tc.size >= 0 {
				req.Header.Set("Content-Length", strconv.FormatInt(tc.size, 10))
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			if w.Code != tc.status {
				t.Fatalf("got %d want %d: %s", w.Code, tc.status, w.Body.String())
			}
			entries, e := os.ReadDir(data)
			if e != nil || len(entries) != 0 {
				t.Fatal("temporary files remain", entries, e)
			}
		})
	}
	var count int
	if e := db.DB.QueryRow("SELECT count(*) FROM lineage_blobs").Scan(&count); e != nil || count != 1 {
		t.Fatal("failed upload published metadata", count, e)
	}
	entries, e := os.ReadDir(filepath.Join(storage, "o"))
	if e != nil || len(entries) != 1 {
		t.Fatal("failed upload published object", entries, e)
	}
}
