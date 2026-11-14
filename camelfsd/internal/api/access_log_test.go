package api

import (
	"net/url"
	"testing"
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
