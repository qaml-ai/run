package api

import (
	"bytes"
	"encoding/json"
	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLifecycleAndTree(t *testing.T) {
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "1")
	data := t.TempDir()
	s := store.Local{Dir: t.TempDir()}
	db, e := refs.Open(filepath.Join(data, "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	m, e := image.New(image.Config{Data: data, Cold: "prehydrate", HostID: "test"}, s, cache.New(filepath.Join(data, "cache"), s, 4), db)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	api := &Server{Manager: m}
	call := func(method, path string, q any, status int) map[string]any {
		t.Helper()
		b, _ := json.Marshal(q)
		req := httptest.NewRequest(method, path, bytes.NewReader(b))
		w := httptest.NewRecorder()
		api.ServeHTTP(w, req)
		if w.Code != status {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
		var out map[string]any
		if e := json.Unmarshal(w.Body.Bytes(), &out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	tree := strings.Repeat("a", 40)
	call("POST", "/v0/mounts", map[string]any{"jobId": "missing", "lineage": "l", "tree": tree}, 404)
	path := filepath.Join(data, "base.img")
	b := make([]byte, 3*root.ChunkSize)
	b[100] = 1
	os.WriteFile(path, b, 0600)
	imp := call("POST", "/v0/images", map[string]any{"lineage": "l", "name": "main", "path": path, "tree": tree}, 200)
	if imp["tree"] != tree {
		t.Fatal(imp)
	}
	mount := call("POST", "/v0/mounts", map[string]any{"jobId": "j1", "lineage": "l", "ref": "main"}, 200)
	if mount["warm"] != true {
		t.Fatal(mount)
	}
	f, e := os.OpenFile(mount["image"].(string), os.O_RDWR, 0)
	if e != nil {
		t.Fatal(e)
	}
	f.WriteAt([]byte("changed"), root.ChunkSize+7)
	f.Close()
	cp := call("POST", "/v0/mounts/j1/checkpoint", map[string]any{}, 200)
	if cp["changedChunks"] != float64(1) || cp["root"] == imp["root"] {
		t.Fatal(cp)
	}
	got, e := db.TreeRoot("l", tree)
	if e != nil || got != cp["root"] {
		t.Fatal(got, e)
	}
	tm := call("POST", "/v0/mounts", map[string]any{"jobId": "treejob", "lineage": "l", "tree": tree}, 200)
	if tm["root"] != cp["root"] {
		t.Fatal(tm)
	}
	ref, e := db.Get("l", "job/treejob")
	if e != nil || ref.Owner != "job:treejob" || ref.Tree != tree || ref.Holder == "" {
		t.Fatal(ref, e)
	}
	call("POST", "/v0/mounts", map[string]any{"jobId": "bad", "lineage": "l", "root": got, "tree": tree}, 400)
	call("POST", "/v0/mounts", map[string]any{"jobId": "..", "lineage": "l", "root": got}, 400)
	call("POST", "/v0/mounts", map[string]any{"jobId": "r", "lineage": "l", "root": got}, 200)
	call("POST", "/v0/mounts/r/checkpoint", map[string]any{}, 409)
	call("GET", "/v0/mounts/treejob", nil, 200)
	call("POST", "/v0/trees", map[string]any{}, 501)
	call("PUT", "/v0/blobs/"+strings.Repeat("a", 64), map[string]any{}, 501)
	for _, j := range []string{"j1", "treejob", "r"} {
		call("DELETE", "/v0/mounts/"+j, nil, 200)
	}
	call("GET", "/v0/health", nil, 200)
	call("POST", "/v0/images", map[string]any{"lineage": "l", "name": "x", "path": "/etc/passwd"}, 400)
	os.Remove(mount["image"].(string))
	os.Remove(filepath.Join(data, "images", got+".img"))
	cold := call("POST", "/v0/mounts", map[string]any{"jobId": "cold", "lineage": "l", "root": got}, 200)
	content, e := os.ReadFile(cold["image"].(string))
	if e != nil || string(content[root.ChunkSize+7:root.ChunkSize+14]) != "changed" {
		t.Fatal(e)
	}
	call("DELETE", "/v0/mounts/cold", nil, 200)
}
