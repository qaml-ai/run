package api

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestPhase1MountFenceCompatibility(t *testing.T) {
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "1")
	data := t.TempDir()
	st := store.Local{Dir: t.TempDir()}
	db, e := refs.Open(filepath.Join(data, "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	m, e := image.New(image.Config{Data: data, Cold: "prehydrate", HostID: "phase1-host", VirtualSize: 16 << 20}, st, cache.New(filepath.Join(data, "cache"), st, 4), db)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	repo := &objects.Repository{DB: db, Store: st}
	tr, e := repo.Import(context.Background(), objects.Request{Lineage: "l", Files: map[string]objects.File{}})
	if e != nil {
		t.Fatal(e)
	}
	s := &Server{Manager: m}
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(previous)
	call := func(method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		raw, e := json.Marshal(body)
		if e != nil {
			t.Fatal(e)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest(method, path, bytes.NewReader(raw)))
		return w
	}
	for _, tc := range []struct {
		job   string
		fence *refs.Fence
	}{
		{"missing", &refs.Fence{Holder: "phase1-host/missing", Epoch: 0}},
		{"null", nil},
		{"given", &refs.Fence{Holder: "runtime", Epoch: 7}},
	} {
		t.Run(tc.job, func(t *testing.T) {
			q := map[string]any{"jobId": tc.job, "lineage": "l", "tree": tr.Tree}
			if tc.job != "missing" {
				q["fence"] = tc.fence
			}
			if w := call("POST", "/v0/mounts", q); w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			for _, route := range []string{tc.job, "not-mounted"} {
				w := call("POST", "/v0/mounts/"+route+"/heartbeat", map[string]any{"epoch": 999})
				if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"deprecated":true,"ok":true}` {
					t.Fatal(w.Code, w.Body.String())
				}
			}
			w := call("GET", "/v0/mounts/"+tc.job, nil)
			var status struct{ Fence *refs.Fence }
			if e := json.Unmarshal(w.Body.Bytes(), &status); e != nil || w.Code != 200 || !reflect.DeepEqual(status.Fence, tc.fence) {
				t.Fatal(w.Code, w.Body.String(), e)
			}
			if tc.fence == nil {
				w = call("POST", "/v0/mounts/"+tc.job+"/checkpoint", map[string]any{})
				if w.Code != 409 || !strings.Contains(w.Body.String(), "no_fence") {
					t.Fatal(w.Code, w.Body.String())
				}
			} else {
				cp, e := m.Checkpoint(context.Background(), tc.job)
				if e != nil || cp.Tree == "" || cp.Root == "" || cp.Commit == "" {
					t.Fatal(cp, e)
				}
			}
		})
	}
	if !strings.Contains(logs.String(), "op=mount legacy-fence jobId=missing") || strings.Count(logs.String(), "legacy-fence") != 1 {
		t.Fatal(logs.String())
	}
	var n int
	if e = db.DB.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='refs'").Scan(&n); e != nil || n != 0 {
		t.Fatal(n, e)
	}
}
