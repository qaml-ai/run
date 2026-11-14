package computehost

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestComputeErrorEnvelopes(t *testing.T) {
	check := func(w *httptest.ResponseRecorder, status int, code string) errorBody {
		t.Helper()
		var body errorEnvelope
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || w.Code != status || body.Error.Code != code || body.Error.Message == "" {
			t.Fatalf("HTTP %d %s, expected HTTP %d %s, decode: %v", w.Code, w.Body, status, code, err)
		}
		return body.Error
	}
	h := new(Host)
	for _, path := range []string{"/v1/vms", "/v1/vms/vm/stop", "/v1/vms/vm/exec", "/v1/vms/vm/checkpoint"} {
		w := httptest.NewRecorder()
		h.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, path, strings.NewReader("{")))
		check(w, 400, "invalid_request")
	}
	for _, route := range []struct{ method, path string }{
		{http.MethodPost, "/v1/vms/vm/shells"},
		{http.MethodGet, "/v1/vms/vm/exec/missing"},
	} {
		w := httptest.NewRecorder()
		h.Handler().ServeHTTP(w, httptest.NewRequest(route.method, route.path, nil))
		check(w, 404, "vm_unknown")
	}
	for _, q := range []httpError{{404, "exec_unknown"}, {409, "shell_busy"}, {409, "exec_conflict"}} {
		w := httptest.NewRecorder()
		report(w, &q)
		check(w, q.status, q.code)
	}
	w := httptest.NewRecorder()
	replyTruncatedTail(w, 42)
	body := check(w, 410, "tail_truncated")
	if string(body.Details) != `{"firstOffset":42}` {
		t.Fatalf("tail details: %s", body.Details)
	}
	w = httptest.NewRecorder()
	report(w, &tierError{Status: 412, Code: "stale", Body: []byte(`{"error":{"code":"stale","message":"stale","details":{"current":"head"}}}`)})
	body = check(w, 412, "stale")
	if string(body.Details) != `{"current":"head"}` {
		t.Fatalf("CAS details: %s", body.Details)
	}
	w = httptest.NewRecorder()
	report(w, &tierError{Status: 412, Code: "stale", Body: []byte(`{"error":"stale","current":"head"}`)})
	check(w, 502, "host_unavailable") // a flat tier error is malformed, never relayed
}

func TestShellKeyValidation(t *testing.T) {
	maxKey := strings.Repeat("a", 96)
	h := new(Host).Handler()
	for _, tc := range []struct {
		body, code string
		status     int
	}{
		{"", "vm_unknown", 404},
		{`{}`, "vm_unknown", 404},
		{`{"shellKey":"job_1.part-2"}`, "vm_unknown", 404},
		{`{"shellKey":"` + maxKey + `"}`, "vm_unknown", 404},
		{`{"shellKey":"` + maxKey + `a"}`, "invalid_request", 400},
		{`{"shellKey":""}`, "invalid_request", 400},
		{`{"shellKey":null}`, "invalid_request", 400},
		{`{"shellKey":1}`, "invalid_request", 400},
		{`{"shellKey":"bad/key"}`, "invalid_request", 400},
		{`{"shellKey":"valid"} {}`, "invalid_request", 400},
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/vms/vm/shells", strings.NewReader(tc.body)))
		var out errorEnvelope
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != tc.status || out.Error.Code != tc.code {
			t.Errorf("body %q: HTTP %d %s, want %d %s", tc.body, w.Code, w.Body, tc.status, tc.code)
		}
	}
}
