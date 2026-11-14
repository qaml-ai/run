package api

import (
	"bytes"
	"log"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/compute"
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
