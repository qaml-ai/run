package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
)

func TestVerifierEd25519AndDevToken(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	_, wrongPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey wrong: %v", err)
	}

	now := time.Unix(1763400000, 0)
	spec := fmt.Sprintf("k1:%s", base64.RawURLEncoding.EncodeToString(pub))
	v, err := NewVerifier(Config{
		PublicKeysSpec: spec,
		DevToken:       "dev-secret-123",
		HostToken:      "host-secret-456",
		NowFn:          func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	// 1. Valid Ed25519 JWT
	tok, err := SignToken("k1", priv, Claims{
		Iss:    "camelrun",
		Sub:    "ten_abc",
		Lin:    "lin_1",
		Scopes: []string{ScopeRepoRead, ScopeRepoWrite},
		Exp:    now.Add(5 * time.Minute).Unix(),
	})
	if err != nil {
		t.Fatalf("SignToken: %v", err)
	}

	p, err := v.VerifyBearer("Bearer "+tok, "")
	if err != nil {
		t.Fatalf("VerifyBearer valid JWT: %v", err)
	}
	if p.TenantID != "ten_abc" || p.Lineage != "lin_1" {
		t.Fatalf("unexpected principal: %+v", p)
	}
	if err := p.Authorize(ScopeRepoRead, "lin_1"); err != nil {
		t.Fatalf("Authorize valid: %v", err)
	}
	if err := p.Authorize(ScopeVMExec, "lin_1"); !apperr.IsCode(err, apperr.CodeUnauthorized) {
		t.Fatalf("expected unauthorized for missing vm:exec scope, got %v", err)
	}
	if err := p.Authorize(ScopeRepoRead, "lin_other"); !apperr.IsCode(err, apperr.CodeUnauthorized) {
		t.Fatalf("expected unauthorized for mismatched lineage, got %v", err)
	}

	// 2. Expired JWT
	expiredTok, _ := SignToken("k1", priv, Claims{
		Sub:    "ten_abc",
		Lin:    "*",
		Scopes: []string{ScopeRepoRead},
		Exp:    now.Add(-1 * time.Second).Unix(),
	})
	if _, err := v.VerifyBearer("Bearer "+expiredTok, ""); !apperr.IsCode(err, apperr.CodeUnauthorized) {
		t.Fatalf("expected expired token rejection, got %v", err)
	}

	// 3. Wrong signature
	badSigTok, _ := SignToken("k1", wrongPriv, Claims{
		Sub:    "ten_abc",
		Lin:    "*",
		Scopes: []string{ScopeRepoRead},
		Exp:    now.Add(5 * time.Minute).Unix(),
	})
	if _, err := v.VerifyBearer("Bearer "+badSigTok, ""); !apperr.IsCode(err, apperr.CodeUnauthorized) {
		t.Fatalf("expected bad signature rejection, got %v", err)
	}

	// 4. Unknown kid
	badKidTok, _ := SignToken("unknown", priv, Claims{
		Sub:    "ten_abc",
		Lin:    "*",
		Scopes: []string{ScopeRepoRead},
		Exp:    now.Add(5 * time.Minute).Unix(),
	})
	if _, err := v.VerifyBearer("Bearer "+badKidTok, ""); !apperr.IsCode(err, apperr.CodeUnauthorized) {
		t.Fatalf("expected unknown kid rejection, got %v", err)
	}

	// 5. Dev token fallback with X-Camel-Tenant
	devP, err := v.VerifyBearer("Bearer dev-secret-123", "ten_local")
	if err != nil {
		t.Fatalf("VerifyBearer dev token: %v", err)
	}
	if !devP.IsDev || devP.TenantID != "ten_local" {
		t.Fatalf("unexpected dev principal: %+v", devP)
	}
	if err := devP.Authorize(ScopeVMExec, "lin_any"); err != nil {
		t.Fatalf("dev principal should allow all scopes & lineages: %v", err)
	}

	// 6. Host token verification
	req := httptest.NewRequest("POST", "/v1/hosts/heartbeat", nil)
	req.Header.Set("Authorization", "Bearer host-secret-456")
	if err := v.VerifyHostRequest(req); err != nil {
		t.Fatalf("VerifyHostRequest valid: %v", err)
	}
	reqBad := httptest.NewRequest("POST", "/v1/hosts/heartbeat", nil)
	reqBad.Header.Set("Authorization", "Bearer wrong")
	if err := v.VerifyHostRequest(reqBad); !apperr.IsCode(err, apperr.CodeUnauthorized) {
		t.Fatalf("expected unauthorized host token, got %v", err)
	}
}
