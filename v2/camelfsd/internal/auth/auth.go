package auth

import (
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
)

const (
	ScopeRepoRead  = "repo:read"
	ScopeRepoWrite = "repo:write"
	ScopeVMExec    = "vm:exec"

	JWTType = "camelfs+jwt"
	JWTAlg  = "EdDSA"
)

type jwtHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
	Kid string `json:"kid"`
}

type Claims struct {
	Iss    string   `json:"iss,omitempty"`
	Sub    string   `json:"sub"`
	Lin    string   `json:"lin"`
	Scopes []string `json:"scopes"`
	Exp    int64    `json:"exp"`
	Iat    int64    `json:"iat,omitempty"`
}

type Principal struct {
	TenantID string
	Lineage  string
	Scopes   map[string]bool
	IsDev    bool
}

func (p *Principal) HasScope(scope string) bool {
	if p == nil {
		return false
	}
	if p.Scopes["*"] {
		return true
	}
	return p.Scopes[scope]
}

func (p *Principal) AllowsLineage(lineage string) bool {
	if p == nil {
		return false
	}
	if p.Lineage == "*" || lineage == "" {
		return true
	}
	return p.Lineage == lineage
}

func (p *Principal) Authorize(scope string, lineage string) error {
	if p == nil {
		return apperr.Unauthorized("missing authentication principal")
	}
	if !p.HasScope(scope) {
		return apperr.Forbidden(fmt.Sprintf("missing required scope %q", scope))
	}
	if lineage != "" && !p.AllowsLineage(lineage) {
		return apperr.Forbidden(fmt.Sprintf("token not authorized for lineage %q", lineage))
	}
	return nil
}

type Verifier struct {
	pubKeys   map[string]ed25519.PublicKey
	devToken  string
	hostToken string
	nowFn     func() time.Time
}

type Config struct {
	PublicKeysSpec string
	PublicKeys     map[string]ed25519.PublicKey
	DevToken       string
	HostToken      string
	NowFn          func() time.Time
}

func NewVerifier(cfg Config) (*Verifier, error) {
	keys := make(map[string]ed25519.PublicKey)
	for k, v := range cfg.PublicKeys {
		if len(v) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("invalid ed25519 public key size for kid %q: got %d", k, len(v))
		}
		dup := make(ed25519.PublicKey, ed25519.PublicKeySize)
		copy(dup, v)
		keys[k] = dup
	}
	if strings.TrimSpace(cfg.PublicKeysSpec) != "" {
		parsed, err := ParsePublicKeys(cfg.PublicKeysSpec)
		if err != nil {
			return nil, err
		}
		for k, v := range parsed {
			keys[k] = v
		}
	}
	nowFn := cfg.NowFn
	if nowFn == nil {
		nowFn = time.Now
	}
	return &Verifier{
		pubKeys:   keys,
		devToken:  cfg.DevToken,
		hostToken: cfg.HostToken,
		nowFn:     nowFn,
	}, nil
}

// ParsePublicKeys parses "<kid>:<base64url-32-byte-pubkey>[,...]".
func ParsePublicKeys(spec string) (map[string]ed25519.PublicKey, error) {
	out := make(map[string]ed25519.PublicKey)
	for _, entry := range strings.Split(spec, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		kid, rawB64, ok := strings.Cut(entry, ":")
		if !ok || strings.TrimSpace(kid) == "" || strings.TrimSpace(rawB64) == "" {
			return nil, fmt.Errorf("invalid public key entry %q (expected <kid>:<base64url-pubkey>)", entry)
		}
		kid = strings.TrimSpace(kid)
		rawB64 = strings.TrimSpace(rawB64)
		pub, err := decodeBase64Flexible(rawB64)
		if err != nil {
			return nil, fmt.Errorf("invalid base64 public key for kid %q: %w", kid, err)
		}
		if len(pub) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("invalid ed25519 public key length for kid %q: got %d, want %d", kid, len(pub), ed25519.PublicKeySize)
		}
		out[kid] = ed25519.PublicKey(pub)
	}
	return out, nil
}

func decodeBase64Flexible(s string) ([]byte, error) {
	sNoPad := strings.TrimRight(s, "=")
	if strings.ContainsAny(sNoPad, "-_") {
		return base64.RawURLEncoding.DecodeString(sNoPad)
	}
	if b, err := base64.RawURLEncoding.DecodeString(sNoPad); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(sNoPad)
}

func extractBearer(header string) (string, error) {
	header = strings.TrimSpace(header)
	if header == "" {
		return "", apperr.Unauthorized("missing Authorization header")
	}
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return "", apperr.Unauthorized("Authorization header must use Bearer scheme")
	}
	tok := strings.TrimSpace(parts[1])
	if tok == "" {
		return "", apperr.Unauthorized("empty bearer token")
	}
	return tok, nil
}

func (v *Verifier) VerifyRequest(r *http.Request) (*Principal, error) {
	return v.VerifyBearer(r.Header.Get("Authorization"), r.Header.Get("X-Camel-Tenant"))
}

func (v *Verifier) VerifyBearer(authHeader string, tenantHeader string) (*Principal, error) {
	token, err := extractBearer(authHeader)
	if err != nil {
		return nil, err
	}

	if v.devToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(v.devToken)) == 1 {
		tenant := strings.TrimSpace(tenantHeader)
		if tenant == "" {
			tenant = "dev"
		}
		return &Principal{
			TenantID: tenant,
			Lineage:  "*",
			Scopes: map[string]bool{
				ScopeRepoRead:  true,
				ScopeRepoWrite: true,
				ScopeVMExec:    true,
			},
			IsDev: true,
		}, nil
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, apperr.Unauthorized("invalid token format")
	}

	hdrBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, apperr.Unauthorized("invalid JWT header encoding")
	}
	var hdr jwtHeader
	if err := json.Unmarshal(hdrBytes, &hdr); err != nil {
		return nil, apperr.Unauthorized("invalid JWT header JSON")
	}
	if hdr.Alg != JWTAlg {
		return nil, apperr.Unauthorized(fmt.Sprintf("unsupported JWT alg %q", hdr.Alg))
	}
	if hdr.Typ != JWTType {
		return nil, apperr.Unauthorized(fmt.Sprintf("unsupported JWT typ %q", hdr.Typ))
	}
	if hdr.Kid == "" {
		return nil, apperr.Unauthorized("missing JWT kid")
	}

	pub, ok := v.pubKeys[hdr.Kid]
	if !ok {
		return nil, apperr.Unauthorized(fmt.Sprintf("unknown signing key %q", hdr.Kid))
	}

	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sigBytes) != ed25519.SignatureSize {
		return nil, apperr.Unauthorized("invalid JWT signature encoding")
	}

	signingInput := parts[0] + "." + parts[1]
	if !ed25519.Verify(pub, []byte(signingInput), sigBytes) {
		return nil, apperr.Unauthorized("JWT signature verification failed")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, apperr.Unauthorized("invalid JWT payload encoding")
	}
	var claims Claims
	if err := json.Unmarshal(payloadBytes, &claims); err != nil {
		return nil, apperr.Unauthorized("invalid JWT claims JSON")
	}
	if strings.TrimSpace(claims.Sub) == "" {
		return nil, apperr.Unauthorized("missing JWT sub claim")
	}
	if strings.TrimSpace(claims.Lin) == "" {
		return nil, apperr.Unauthorized("missing JWT lin claim")
	}
	if claims.Exp <= 0 {
		return nil, apperr.Unauthorized("missing JWT exp claim")
	}
	nowUnix := v.nowFn().Unix()
	if nowUnix >= claims.Exp {
		return nil, apperr.Unauthorized("JWT has expired")
	}

	scopeSet := make(map[string]bool, len(claims.Scopes))
	for _, s := range claims.Scopes {
		scopeSet[s] = true
	}

	return &Principal{
		TenantID: claims.Sub,
		Lineage:  claims.Lin,
		Scopes:   scopeSet,
	}, nil
}

func (v *Verifier) VerifyHostRequest(r *http.Request) error {
	expected := v.hostToken
	if expected == "" {
		expected = v.devToken
	}
	if expected == "" {
		return apperr.Unauthorized("host authentication is not configured")
	}
	candidate := strings.TrimSpace(r.Header.Get("X-Host-Token"))
	if candidate == "" {
		var err error
		candidate, err = extractBearer(r.Header.Get("Authorization"))
		if err != nil {
			return err
		}
	}
	if subtle.ConstantTimeCompare([]byte(candidate), []byte(expected)) != 1 {
		return apperr.Unauthorized("invalid host token")
	}
	return nil
}

// SignToken creates an Ed25519 camelfs+jwt token.
func SignToken(kid string, priv ed25519.PrivateKey, claims Claims) (string, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return "", fmt.Errorf("invalid ed25519 private key length %d", len(priv))
	}
	hdr := jwtHeader{
		Alg: JWTAlg,
		Typ: JWTType,
		Kid: kid,
	}
	hdrBytes, err := json.Marshal(hdr)
	if err != nil {
		return "", err
	}
	claimsBytes, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	hEnc := base64.RawURLEncoding.EncodeToString(hdrBytes)
	cEnc := base64.RawURLEncoding.EncodeToString(claimsBytes)
	signingInput := hEnc + "." + cEnc
	sig := ed25519.Sign(priv, []byte(signingInput))
	sEnc := base64.RawURLEncoding.EncodeToString(sig)
	return signingInput + "." + sEnc, nil
}
