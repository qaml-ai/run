package api

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestStorageLogRouteRefActions(t *testing.T) {
	l := "lin_abc"
	for _, c := range []struct{ method, path, want string }{
		{"GET", "/v1/lineages/" + l + "/refs/main", "/v1/lineages/:lineage/refs/:name"},
		{"DELETE", "/v1/lineages/" + l + "/refs/main", "/v1/lineages/:lineage/refs/:name"},
		{"POST", "/v1/lineages/" + l + "/refs/heads%2Fsecret-name/cas", "/v1/lineages/:lineage/refs/:name/cas"},
		{"POST", "/v1/lineages/" + l + "/refs/main/write", "/v1/lineages/:lineage/refs/:name/write"},
		{"POST", "/v1/lineages/" + l + "/refs/main/merge", "/v1/lineages/:lineage/refs/:name/merge"},
		{"POST", "/v1/lineages/" + l + "/refs/main/restore", "/v1/lineages/:lineage/refs/:name/restore"},
		{"POST", "/v1/lineages/" + l + "/refs/main/lease", "/v1/lineages/:lineage/refs/:name/lease"},
		{"DELETE", "/v1/lineages/" + l + "/refs/main/lease", "/v1/lineages/:lineage/refs/:name/lease"},
		{"POST", "/v1/lineages/" + l + "/refs/main/lease/renew", "/v1/lineages/:lineage/refs/:name/lease/renew"},
		{"PUT", "/v1/lineages/" + l + "/refs/main/watchers/w1", "/v1/lineages/:lineage/refs/:name/watchers/:watcher"},
		{"POST", "/v1/lineages/" + l + "/refs/main/bogus", "/v1/lineages/:lineage/refs/:name"},
		{"POST", "/v1/lineages/" + l + "/refs/x%2Fcas", "/v1/lineages/:lineage/refs/:name"},
	} {
		u, err := url.Parse(c.path)
		if err != nil {
			t.Fatal(err)
		}
		got, lineage := storageLogRoute(c.method, u)
		if got != c.want || lineage != l {
			t.Errorf("%s %s: got %q want %q", c.method, c.path, got, c.want)
		}
	}
}

func TestVMAccessLogRoutes(t *testing.T) {
	s := vmTestServer(&compute.Controller{}, nil, nil)
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previous) })
	for _, c := range []struct{ method, path, route string }{
		{"POST", "/v1/vms", "/v1/vms"},
		{"GET", "/v1/vms/private-vm?q=private-query", "/v1/vms/:id"},
		{"POST", "/v1/vms/private-vm/stop", "/v1/vms/:id/stop"},
		{"POST", "/v1/vms/private-vm/deadline", "/v1/vms/:id/deadline"},
		{"POST", "/v1/vms/private-vm/shells", "/v1/vms/:id/shells"},
		{"POST", "/v1/vms/private-vm/checkpoint", "/v1/vms/:id/checkpoint"},
		{"POST", "/v1/vms/private-vm/exec", "/v1/vms/:id/exec"},
		{"GET", "/v1/vms/private-vm/exec/private-exec", "/v1/vms/:id/exec/:execId"},
		{"GET", "/v1/vms/private-vm/private-action", "/v1/vms"},
	} {
		logs.Reset()
		r := httptest.NewRequest(c.method, c.path, strings.NewReader("private-body"))
		s.ServeHTTP(httptest.NewRecorder(), r)
		if got := logs.String(); strings.Count(got, "\n") != 1 || strings.Contains(got, "private-") ||
			!strings.Contains(got, "op="+c.method+":"+c.route+" status=401 ms=") {
			t.Errorf("%s %s: %q", c.method, c.path, got)
		}
	}
}

func TestRefMoveAccessLogPhases(t *testing.T) {
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previous) })
	path := "/v1/lineages/l/refs/main/write"
	req := httptest.NewRequest(http.MethodPost, path, nil)
	route, lineage := storageLogRoute(req.Method, req.URL)
	loggedAccess(httptest.NewRecorder(), req, route, lineage, func(w http.ResponseWriter, r *http.Request) {
		timing := refTimingFrom(r.Context())
		timing.objects.Put = time.Millisecond
		timing.objects.PutKeys = 2
		timing.build = 3 * time.Millisecond
		timing.ddb = 4 * time.Millisecond
		timing.retries = 1
		timing.head = 5 * time.Millisecond
		timing.treeRead.read = 6 * time.Millisecond
		timing.diff = 7 * time.Millisecond
		timing.objects.Cache = 8 * time.Millisecond
		timing.usage = 9 * time.Millisecond
		timing.cas = 10 * time.Millisecond
		w.WriteHeader(http.StatusCreated)
	})
	want := " objectsMs=1.000 putKeys=2 buildMs=3.000 ddbMs=4.000 ddbRetries=1 headMs=5.000 readTreeMs=6.000 diffMs=7.000 cacheMs=8.000 usageMs=9.000 casMs=10.000"
	if got := logs.String(); !strings.Contains(got, "op=POST:"+route+" lineage=l status=201 ms=") || !strings.HasSuffix(got, want+"\n") {
		t.Fatalf("access log = %q, want phase suffix %q", got, want)
	}
}

func TestReadAccessLogPhases(t *testing.T) {
	s := storageServer(t, store.Local{Dir: t.TempDir()})
	blob := put(t, s, "l", "abc")
	tree := commit(t, s, "l", "", []change{{Path: "nested/file", Blob: blob}})["tree"].(string)
	if _, err := s.repo.DB.DB.Exec("DELETE FROM objects; DELETE FROM tree_sizes"); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previous) })
	body := map[string]any{"tree": tree, "paths": []string{"nested/file", "missing"}}
	for _, want := range [][]string{
		{"treeCacheHits=0", "treeCacheMisses=2", "blobCacheHits=0", "blobCacheMisses=1"},
		{"treeCacheHits=2", "treeCacheMisses=0", "blobCacheHits=1", "blobCacheMisses=0"},
	} {
		logs.Reset()
		callStorage(t, s, "l", "POST", "read", body, "", 200)
		for _, field := range append(want, "/v1/lineages/:lineage/read", "lineageMs=", "treeMembershipMs=", "treeMs=", "treeReads=2", "blobMs=", "blobReads=1") {
			if !strings.Contains(logs.String(), field) {
				t.Errorf("access log = %q, missing %q", logs.String(), field)
			}
		}
	}
}

// GET /v1/usage is access-logged with its status, time and how many events the page returned (and nothing else from
// the request: no cursor, no token).
func TestUsageAccessLog(t *testing.T) {
	var out bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&out)
	t.Cleanup(func() { log.SetOutput(previous) })
	r := httptest.NewRequest("GET", "/v1/usage?after=secret-cursor&limit=1000", nil)
	w := httptest.NewRecorder()
	loggedAccess(w, r, "/v1/usage", "", func(w http.ResponseWriter, r *http.Request) {
		count, ok := r.Context().Value(usageCountKey{}).(*usageCount)
		if !ok {
			t.Fatal("no usage counter in the request context")
		}
		count.events = 3
		w.WriteHeader(200)
	})
	line := out.String()
	if !strings.Contains(line, "op=GET:/v1/usage status=200 ms=") || !strings.Contains(line, " events=3") || strings.Contains(line, "secret-cursor") {
		t.Fatalf("access line: %q", line)
	}
}
