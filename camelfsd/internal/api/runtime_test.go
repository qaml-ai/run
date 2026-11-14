package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestRuntimeTCPImportRoutesRequireBearer(t *testing.T) {
	local := store.Local{Dir: t.TempDir()}
	s := storageServer(t, local)
	tcp := httptest.NewServer(s.RuntimeHandler())
	defer tcp.Close()
	call := func(method, path, body, authorization string, want int) []byte {
		t.Helper()
		req, e := http.NewRequest(method, tcp.URL+path, strings.NewReader(body))
		if e != nil {
			t.Fatal(e)
		}
		if authorization != "" {
			req.Header.Set("Authorization", authorization)
		}
		resp, e := tcp.Client().Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		raw, e := io.ReadAll(resp.Body)
		if e != nil {
			t.Fatal(e)
		}
		if resp.StatusCode != want {
			t.Fatalf("%s %s: %d %s", method, path, resp.StatusCode, raw)
		}
		return raw
	}
	blob := "hello"
	hash := root.Hash([]byte(blob))
	blobPath := "/v0/blobs/" + hash + "?lineage=tenant:repo"
	treeBody := `{"lineage":"tenant:repo","files":{"hello":{"sha256":"` + hash + `"}}}`
	for _, auth := range []string{"", "Bearer wrong"} {
		call("PUT", blobPath, blob, auth, 401)
		call("POST", "/v0/trees", treeBody, auth, 401)
		call("GET", "/v1/lineages/tenant:repo/trees/"+strings.Repeat("a", 40), "", auth, 401)
	}
	var uploaded objects.Blob
	if e := json.Unmarshal(call("PUT", blobPath, blob, "Bearer test", 201), &uploaded); e != nil {
		t.Fatal(e)
	}
	if uploaded.SHA1 != store.GitHash("blob", []byte(blob)) {
		t.Fatal(uploaded)
	}
	var tree objects.Result
	if e := json.Unmarshal(call("POST", "/v0/trees", treeBody, "Bearer test", 200), &tree); e != nil || tree.Tree == "" {
		t.Fatal(tree, e)
	}
	call("GET", "/v1/lineages/tenant:repo/trees/"+tree.Tree, "", "Bearer test", 200)
	for _, auth := range []string{"", "Bearer test"} {
		for _, route := range []struct{ method, path string }{
			{"GET", "/v0/health"}, {"POST", "/v0/mounts"}, {"POST", "/v0/mounts/j/heartbeat"},
			{"POST", "/v0/images"}, {"GET", "/v0/commits/" + strings.Repeat("a", 40)},
			{"GET", "/v0/trees/" + tree.Tree}, {"GET", blobPath}, {"POST", blobPath},
			{"PUT", "/v0/blobs/" + hash + "/extra"}, {"POST", "/v0/trees/extra"},
		} {
			call(route.method, route.path, "{}", auth, 404)
		}
	}
	// Unix handler retains its existing unauthenticated import behavior.
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("POST", "/v0/trees", bytes.NewBufferString(treeBody)))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}
