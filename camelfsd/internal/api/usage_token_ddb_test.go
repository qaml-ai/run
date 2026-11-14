package api

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/auth"
	"github.com/qaml-ai/run/camelfsd/internal/compute"
)

// The runtime's usage poll, end to end through the real token verifier: the token the runtime mints (usage.ts
// pollUsage claims {sub: "runtime:usage", acc: "r"}, extended by camelfsToken with refs [], iss, aud, iat, exp, jti;
// no lineage) reads GET /v1/usage, and nothing else. Smoke 7 found the verifier refusing it (BadLineage), which no test
// saw: the usage tests authenticate through a test header, not a token.
func TestDDBUsageTokenContract(t *testing.T) {
	db, vms := hostTable(t, "id")
	_, hosts := hostTable(t, "pool", "host")
	_, deliveries := hostTable(t, "shard", "id")
	_, usageTable := hostTable(t, "shard", "ulid")
	c := &compute.Controller{DB: db, Tables: compute.Tables{VMs: vms, Hosts: hosts, Deliveries: deliveries, Usage: usageTable}}

	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	encode := base64.RawURLEncoding.EncodeToString
	raw, _ := json.Marshal(map[string]any{"keys": []map[string]string{
		{"kty": "OKP", "crv": "Ed25519", "kid": "runtime", "alg": "EdDSA", "use": "sig", "x": encode(pub)},
	}})
	inline := string(raw)
	keys, err := auth.Load("", &inline, auth.Options{Typ: auth.RuntimeType, Audience: auth.RuntimeAudience, Issuer: "https://runtime.example", MaxTTL: auth.DefaultMaxTTL})
	if err != nil {
		t.Fatal(err)
	}
	mint := func(claims map[string]any) string {
		now := time.Now().Unix()
		claims["iss"], claims["aud"], claims["iat"], claims["exp"], claims["jti"] = "https://runtime.example", "camelrun:camelfs", now, now+300, "jti"
		payload, _ := json.Marshal(claims)
		signed := encode([]byte(`{"alg":"EdDSA","kid":"runtime","typ":"camelfs+jwt"}`)) + "." + encode(payload)
		return signed + "." + encode(ed25519.Sign(priv, []byte(signed)))
	}
	usage := mint(map[string]any{"sub": "runtime:usage", "acc": "r", "refs": []string{}})
	bash := mint(map[string]any{"sub": "runtime:bash", "lin": "tenant", "acc": "w", "refs": []string{"branch/*"}})
	writeUsage := mint(map[string]any{"sub": "runtime:usage", "acc": "w", "refs": []string{}})

	s := NewStorageServer(nil, "test", keys)
	s.EnableCompute(&compute.Loop{C: c}, []string{strings.Repeat("a", 64)}, []string{"build"}, map[string]int64{}, 10*time.Second)
	call := func(method, path, token, body string, status int, want string) {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != status || !strings.Contains(w.Body.String(), want) {
			t.Fatalf("%s %s: got %d %s, want %d %s", method, path, w.Code, w.Body.String(), status, want)
		}
	}
	// The runtime's exact token reads the usage ledger.
	call("GET", "/v1/usage", usage, "", 200, `"events":[]`)
	call("GET", "/v1/usage?limit=1", usage, "", 200, `"cursor"`)
	// And nothing else: VM routes, a write, another method.
	vm := fmt.Sprintf(`{"id":"vm","lineage":"tenant","ref":"branch/main","image":%q,"shape":{"vcpus":1,"memoryMiB":1024,"diskGiB":2},"pool":"build","network":{"internet":false},"usage":{"payer":"p"},"deadline":%d}`,
		strings.Repeat("a", 64), time.Now().Add(time.Minute).UnixMilli())
	call("POST", "/v1/vms", usage, vm, 403, "a usage token reads only GET /v1/usage")
	call("GET", "/v1/vms/vm", usage, "", 403, "forbidden")
	call("POST", "/v1/vms/vm/exec", usage, `{}`, 403, "forbidden")
	call("POST", "/v1/vms/vm/stop", usage, `{}`, 403, "forbidden")
	// A usage subject with write access, or any other subject without a lineage, never authenticates.
	call("GET", "/v1/usage", writeUsage, "", 401, "lin must be a valid lineage")
	// The ledger is still the usage poller's only: an ordinary runtime token is refused there.
	call("GET", "/v1/usage", bash, "", 403, "forbidden")
}
