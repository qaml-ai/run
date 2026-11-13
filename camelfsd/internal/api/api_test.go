package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
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
	tr, err := (&objects.Repository{DB: db, Store: s, TempDir: data}).Import(context.Background(), objects.Request{Lineage: "l", Files: map[string]objects.File{}})
	if err != nil {
		t.Fatal(err)
	}
	tree = tr.Tree
	path := filepath.Join(data, "base.img")
	b := make([]byte, 3*root.ChunkSize)
	b[100] = 1
	os.WriteFile(path, b, 0600)
	imp := call("POST", "/v0/images", map[string]any{"lineage": "l", "path": path, "tree": tree}, 200)
	if imp["tree"] != tree {
		t.Fatal(imp)
	}
	mount := call("POST", "/v0/mounts", map[string]any{"jobId": "j1", "lineage": "l", "root": imp["root"], "fence": map[string]any{"holder": "runtime", "epoch": 1}}, 200)
	if mount["warm"] != true {
		t.Fatal(mount)
	}
	f, e := os.OpenFile(mount["image"].(string), os.O_RDWR, 0)
	if e != nil {
		t.Fatal(e)
	}
	f.WriteAt([]byte("changed"), root.ChunkSize+7)
	f.Close()
	cpResult, err := m.Checkpoint(context.Background(), "j1")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(cpResult)
	var cp map[string]any
	json.Unmarshal(raw, &cp)
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
	call("POST", "/v0/mounts", map[string]any{"jobId": "bad", "lineage": "l", "root": got, "tree": tree}, 400)
	call("POST", "/v0/mounts", map[string]any{"jobId": "..", "lineage": "l", "root": got}, 400)
	call("POST", "/v0/mounts", map[string]any{"jobId": "r", "lineage": "l", "root": got, "fence": nil}, 200)
	call("POST", "/v0/mounts/r/checkpoint", map[string]any{}, 409)
	call("GET", "/v0/mounts/treejob", nil, 200)
	call("POST", "/v0/trees", map[string]any{}, 400)
	call("PUT", "/v0/blobs/"+strings.Repeat("a", 64), map[string]any{}, 400)
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

func TestErrorStatusUsesTypes(t *testing.T) {
	for _, q := range []struct {
		err    error
		status int
		code   string
	}{
		{fmt.Errorf("invalid disk JSON not allowed"), 500, "internal"},
		{fmt.Errorf("context: %w", apierr.Invalid("bad input")), 400, "invalid-request"},
		{fmt.Errorf("context: %w", os.ErrNotExist), 404, "not-found"},
	} {
		status, code := errorStatus(q.err)
		if status != q.status || code != q.code {
			t.Fatalf("%v: %d %s", q.err, status, code)
		}
	}
}

func TestFenceOwnership(t *testing.T) {
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "1")
	data := t.TempDir()
	st := store.Local{Dir: t.TempDir()}
	db, e := refs.Open(filepath.Join(data, "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	m, e := image.New(image.Config{Data: data, Cold: "prehydrate", VirtualSize: 16 << 20}, st, cache.New(filepath.Join(data, "cache"), st, 4), db)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	repo := objects.Repository{DB: db, Store: st}
	tr, e := repo.Import(context.Background(), objects.Request{Lineage: "l", Files: map[string]objects.File{}})
	if e != nil {
		t.Fatal(e)
	}
	s := &Server{Manager: m}
	for _, fenced := range []bool{false, true} {
		job := "read"
		var fence *refs.Fence
		if fenced {
			job = "write"
			fence = &refs.Fence{Holder: "runtime", Epoch: 7}
		}
		_, e := m.Mount(context.Background(), image.Request{JobID: job, Lineage: "l", Tree: tr.Tree, Fence: fence})
		if e != nil {
			t.Fatal(e)
		}
		if !fenced {
			w := httptest.NewRecorder()
			s.ServeHTTP(w, httptest.NewRequest("POST", "/v0/mounts/"+job+"/checkpoint", strings.NewReader("{}")))
			if w.Code != 409 || !strings.Contains(w.Body.String(), "no_fence") {
				t.Fatal(w.Code, w.Body.String())
			}
		} else {
			cp, e := m.Checkpoint(context.Background(), job)
			if e != nil || cp.Tree == "" || cp.Commit == "" || cp.Root == "" || cp.Timings == nil {
				t.Fatal(cp, e)
			}
			for _, key := range []string{"l/t/" + cp.Tree, "l/k/" + cp.Commit, "l/r/" + cp.Root} {
				ok, e := st.Has(context.Background(), key)
				if e != nil || !ok {
					t.Fatal(key, e)
				}
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, httptest.NewRequest("GET", "/v0/mounts/"+job, nil))
			if !strings.Contains(w.Body.String(), `"fence":{"holder":"runtime","epoch":7}`) {
				t.Fatal(w.Body.String())
			}
		}
	}
	var n int
	if e = db.DB.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='refs'").Scan(&n); e != nil || n != 0 {
		t.Fatal(n, e)
	}
	for _, route := range []string{"/v0/forks"} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("POST", route, strings.NewReader("{}")))
		if w.Code != 404 {
			t.Fatal(route, w.Code)
		}
	}
}
