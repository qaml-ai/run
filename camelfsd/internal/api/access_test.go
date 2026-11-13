package api

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestStorageAccessLog(t *testing.T) {
	s := storageServer(t, store.Local{Dir: t.TempDir()})
	blob := put(t, s, "l", "private body")
	c := commit(t, s, "l", "", []change{{Path: "private-file", Blob: blob}})
	var logs bytes.Buffer
	old := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(old)
	for _, handler := range []http.Handler{s, s.RuntimeHandler()} {
		for _, tc := range []struct {
			method, path, body, auth, key, route, lineage string
			status                                        int
		}{
			{"POST", "/v1/lineages/l/commits", `{"parents":[],"author":"a"}`, "Bearer test", "replay", "/v1/lineages/:lineage/commits", "l", 201},
			{"POST", "/v1/lineages/l/commits", "invalid replay body", "Bearer test", "replay", "/v1/lineages/:lineage/commits", "l", 201},
			{"GET", "/v1/lineages/l/commits/" + c["commit"].(string), "", "Bearer test", "", "/v1/lineages/:lineage/commits/:commit", "l", 200},
			{"GET", "/v1/lineages/l/blobs/" + blob + "?tree=" + c["tree"].(string) + "&path=private-file&token=query-secret", "", "Bearer test", "", "/v1/lineages/:lineage/blobs/:blob", "l", 206},
			{"POST", "/v1/lineages/l/commits", "private malformed body", "Bearer test", "", "/v1/lineages/:lineage/commits", "l", 400},
			{"GET", "/v1/lineages/l/trees/private-object", "", "Bearer secret-token", "", "/v1/lineages/:lineage/trees/:tree", "l", 401},
			{"GET", "/v1/lineages/l/commits", "", "", "", "/v1/lineages/:lineage/commits", "l", 401},
			{"GET", "/v1/lineages/l/private-route", "", "Bearer test", "", "/v1/unknown", "l", 404},
			{"GET", "/v1/private-route?token=query-secret", "", "Bearer secret-token", "", "/v1/unknown", "-", 401},
			{"GET", "/v1/lineages/bad%0Aline/commits", "", "Bearer test", "", "/v1/unknown", "-", 400},
			{"GET", "/v1/lineages/with%20space/commits", "", "Bearer test", "", "/v1/lineages/:lineage/commits", "with%20space", 404},
			{"GET", "/v1", "", "Bearer test", "", "/v1/unknown", "-", 400},
		} {
			logs.Reset()
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Authorization", tc.auth)
			req.Header.Set("Idempotency-Key", tc.key)
			if tc.status == 206 {
				req.Header.Set("Range", "bytes=0-6")
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if w.Code != tc.status {
				t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body.String())
			}
			pattern := `op=` + regexp.QuoteMeta(tc.method+":"+tc.route+" lineage="+tc.lineage) + ` status=` + strconv.Itoa(tc.status) + ` ms=[0-9]+\.[0-9]{3}$`
			line := strings.TrimSpace(logs.String())
			if strings.Count(line, "\n") != 0 || !regexp.MustCompile(pattern).MatchString(line) {
				t.Fatalf("access log: %q; want %s", line, pattern)
			}
			for _, secret := range []string{"private", "secret-token", "query-secret", blob, c["tree"].(string), c["commit"].(string)} {
				if strings.Contains(line, secret) {
					t.Fatalf("access log includes %q: %s", secret, line)
				}
			}
		}
	}
}
