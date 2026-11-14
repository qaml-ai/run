package api

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/auth"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestAPIRole(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	encode := base64.RawURLEncoding.EncodeToString
	raw, _ := json.Marshal(map[string]any{"keys": []map[string]string{
		{"kty": "OKP", "crv": "Ed25519", "kid": "test", "alg": "EdDSA", "use": "sig", "x": encode(pub)},
	}})
	inline := string(raw)
	keys, err := auth.Load("", &inline, auth.Options{Typ: auth.RuntimeType, Audience: auth.RuntimeAudience, Issuer: "runtime", MaxTTL: auth.DefaultMaxTTL})
	if err != nil {
		t.Fatal(err)
	}
	token := func(lineage, access string) string {
		now := time.Now().Unix()
		payload, _ := json.Marshal(map[string]any{"iss": "runtime", "aud": "camelrun:camelfs", "sub": "test",
			"iat": now, "exp": now + 120, "lin": lineage, "acc": access, "refs": []string{}})
		signed := encode([]byte(`{"alg":"EdDSA","kid":"test","typ":"camelfs+jwt"}`)) + "." + encode(payload)
		return signed + "." + encode(ed25519.Sign(priv, []byte(signed)))
	}
	db, err := refs.OpenStorage(filepath.Join(t.TempDir(), "storage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := NewStorageServer(&objects.Repository{DB: db, Store: store.Local{Dir: t.TempDir()}}, "test-version", keys)
	read, write := token("a", "r"), token("a", "w")
	for _, tc := range []struct {
		method, path, token, body string
		status                    int
		code                      string
	}{
		{"GET", "/v0/health", "", "", 200, ""},
		{"GET", "/v1/health", "", "", 200, ""},
		{"GET", "/v0/stats", "", "", 401, "unauthorized"},
		{"GET", "/v0/stats", token("elsewhere", "r"), "", 200, ""},
		{"GET", "/v0/stats", write, "", 200, ""},
		{"POST", "/v0/mounts", write, "", 404, ""},
		{"POST", "/v0/trees", write, "", 404, ""},
		{"PUT", "/v0/blobs/abc", write, "", 404, ""},
		{"POST", "/v0/images", write, "", 404, ""},
		{"GET", "/v1/unrelated", write, "", 404, ""},
		{"PUT", "/v1/lineages/a/blobs", "", "hello", 401, "unauthorized"},
		{"PUT", "/v1/lineages/a/blobs", "shared-bearer", "hello", 401, "unauthorized"},
		{"PUT", "/v1/lineages/a/blobs", read, "hello", 403, "forbidden"},
		{"POST", "/v1/lineages/a/commits", read, "", 403, "forbidden"},
		{"POST", "/v1/lineages/a/merge", read, "", 403, "forbidden"},
		{"POST", "/v1/lineages/a/read", read, "", 400, "invalid_request"},
		{"GET", "/v1/lineages/b/trees/abc", read, "", 403, "forbidden"},
		{"PUT", "/v1/lineages/b/blobs", write, "hello", 403, "forbidden"},
		{"PUT", "/v1/lineages/a/blobs", write, "hello", 201, ""},
	} {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		if tc.token != "" {
			req.Header.Set("Authorization", "Bearer "+tc.token)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req)
		if w.Code != tc.status {
			t.Errorf("%s %s: %d %s; want %d", tc.method, tc.path, w.Code, w.Body.String(), tc.status)
			continue
		}
		if tc.code != "" {
			var response struct {
				Error struct{ Code, Message string }
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || response.Error.Code != tc.code || response.Error.Message == "" {
				t.Errorf("%s: %s; want error code %s and a message", tc.path, w.Body.String(), tc.code)
			}
		}
		if (tc.path == "/v0/health" || tc.path == "/v1/health") && strings.TrimSpace(w.Body.String()) != `{"version":"test-version"}` {
			t.Errorf("health = %s", w.Body.String())
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/v0/stats", nil)
	req.Header.Set("Authorization", "Bearer "+read)
	if got, ok := ClaimsFromContext(authorizeToken(httptest.NewRecorder(), req, keys).Context()); !ok || got.Subject != "test" || got.Lineage != "a" || got.Access != "r" || got.KeyID != "test" {
		t.Fatalf("claims context = %+v, %v", got, ok)
	}
}
