package auth

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const issuer = "https://runtime.example"

var runtimeOptions = Options{Typ: RuntimeType, Audience: RuntimeAudience, Issuer: issuer, MaxTTL: DefaultMaxTTL}

func testKey(t *testing.T, kid string) (ed25519.PrivateKey, map[string]string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return priv, map[string]string{"kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": kid, "x": base64.RawURLEncoding.EncodeToString(pub)}
}

func jwks(keys ...map[string]string) string {
	raw, _ := json.Marshal(map[string]any{"keys": keys})
	return string(raw)
}

func jwt(priv ed25519.PrivateKey, header, payload []byte) string {
	encode := base64.RawURLEncoding.EncodeToString
	signed := encode(header) + "." + encode(payload)
	return signed + "." + encode(ed25519.Sign(priv, []byte(signed)))
}

func claimsAt(now time.Time) map[string]any {
	return map[string]any{"iss": issuer, "aud": "camelrun:camelfs", "sub": "agent:1", "lin": "tenant:repo",
		"iat": now.Unix(), "exp": now.Unix() + 120, "acc": "r", "refs": []string{"heads/*", "job/a-b_1.2"},
		"fence": map[string]any{"holder": "agent:1", "epoch": 7}, "unknown": map[string]any{"extra": true}}
}

func TestVerify(t *testing.T) {
	priv, key := testKey(t, "active")
	inline := jwks(key)
	keys, err := Load("", &inline, runtimeOptions)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1700000000, 0)
	header := []byte(`{ "alg": "EdDSA", "typ": "camelfs+jwt", "kid": "active" }`)
	raw, _ := json.Marshal(claimsAt(now))
	valid := jwt(priv, header, raw)
	got, err := keys.Verify(valid, now)
	want := Claims{Subject: "agent:1", Lineage: "tenant:repo", Access: "r", KeyID: "active", IssuedAt: now.Unix(),
		ExpiresAt: now.Unix() + 120, Refs: []string{"heads/*", "job/a-b_1.2"}, Fence: &Fence{Holder: "agent:1", Epoch: 7}}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("Verify = %+v, %v", got, err)
	}

	for _, tc := range []struct {
		name  string
		token string
		want  Reason
	}{
		{"none", jwt(priv, []byte(`{"alg":"none","typ":"camelfs+jwt","kid":"active"}`), raw), BadAlgorithm},
		{"HS256", jwt(priv, []byte(`{"alg":"HS256","typ":"camelfs+jwt","kid":"active"}`), raw), BadAlgorithm},
		{"RS256", jwt(priv, []byte(`{"alg":"RS256","typ":"camelfs+jwt","kid":"active"}`), raw), BadAlgorithm},
		{"missing kid", jwt(priv, []byte(`{"alg":"EdDSA","typ":"camelfs+jwt"}`), raw), MissingKey},
		{"unknown kid", jwt(priv, []byte(`{"alg":"EdDSA","typ":"camelfs+jwt","kid":"missing"}`), raw), UnknownKey},
		{"wrong typ", jwt(priv, []byte(`{"alg":"EdDSA","typ":"file+jwt","kid":"active"}`), raw), BadType},
		{"oversized", strings.Repeat("a", 8193), TokenTooLarge},
		{"padding", valid + "=", Malformed},
		{"standard alphabet", valid + "+", Malformed},
		{"newline", valid + "\n", Malformed},
		{"bad signature", valid[:strings.LastIndexByte(valid, '.')+1] + base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.SignatureSize)), BadSignature},
		{"different header bytes", base64.RawURLEncoding.EncodeToString(append(header, ' ')) + valid[strings.IndexByte(valid, '.'):], BadSignature},
		{"duplicate header key", jwt(priv, []byte(`{"alg":"EdDSA","alg":"EdDSA","typ":"camelfs+jwt","kid":"active"}`), raw), "invalid JWT header: duplicate JSON key"},
		{"duplicate payload key", jwt(priv, header, append([]byte(`{"sub":"other",`), raw[1:]...)), "invalid JWT payload: duplicate JSON key"},
		{"duplicate nested key", jwt(priv, header, append([]byte(`{"extra":[{"a":1,"\u0061":2}],`), raw[1:]...)), "invalid JWT payload: duplicate JSON key"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := keys.Verify(tc.token, now); !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
	for _, name := range []string{"jwk", "jku", "x5u", "crit"} {
		h, _ := json.Marshal(map[string]any{"alg": "EdDSA", "typ": "camelfs+jwt", "kid": "active", name: nil})
		if _, err := keys.Verify(jwt(priv, h, raw), now); !errors.Is(err, BadHeader) {
			t.Fatalf("%s error = %v", name, err)
		}
	}
	for _, tc := range []struct {
		field string
		value any
		want  Reason
	}{
		{"iss", "elsewhere", BadIssuer}, {"aud", "camelrun:file", BadAudience}, {"aud", []string{"camelrun:camelfs"}, BadAudience},
		{"iat", nil, BadIssuedAt}, {"iat", "1700000000", BadIssuedAt}, {"iat", now.Unix() + 6, Future},
		{"exp", nil, BadExpiration}, {"exp", now.Unix(), Expired}, {"exp", now.Unix() + 901, TooLong},
		{"iat", int64(-1 << 63), TooLong}, {"exp", now.Unix() - 1, BadExpiration},
		{"sub", nil, BadSubject}, {"lin", nil, BadLineage}, {"lin", "a/b", BadLineage}, {"acc", nil, BadAccess}, {"acc", "rw", BadAccess},
		{"refs", nil, BadRefs}, {"refs", "heads/*", BadRefs}, {"refs", []any{nil}, BadRefs}, {"refs", []string{"a?"}, BadRefs},
		{"refs", make([]string, 65), BadRefs}, {"fence", []any{}, BadFence}, {"fence", map[string]any{"holder": "x"}, BadFence},
		{"fence", map[string]any{"holder": nil, "epoch": 0}, BadFence}, {"fence", map[string]any{"holder": "x", "epoch": 1.5}, BadFence},
	} {
		obj := claimsAt(now)
		if tc.want == Expired {
			obj["iat"] = now.Unix() - 1
		}
		if tc.value == nil {
			delete(obj, tc.field)
		} else {
			obj[tc.field] = tc.value
		}
		p, _ := json.Marshal(obj)
		if _, err := keys.Verify(jwt(priv, header, p), now); !errors.Is(err, tc.want) {
			t.Errorf("%s=%v: error = %v, want %v", tc.field, tc.value, err, tc.want)
		}
	}
	obj := claimsAt(now)
	obj["iat"], obj["exp"], obj["refs"], obj["acc"] = now.Unix()+5, now.Unix()+905, []string{}, "w"
	delete(obj, "fence")
	p, _ := json.Marshal(obj)
	if got, err := keys.Verify(jwt(priv, header, p), now); err != nil || got.Fence != nil || got.Access != "w" {
		t.Fatalf("boundary token = %+v, %v", got, err)
	}
}

func TestKeySourcesAndReload(t *testing.T) {
	priv, key := testKey(t, "old")
	nextPriv, nextKey := testKey(t, "new")
	inline := jwks(key)
	path := filepath.Join(t.TempDir(), "jwks.json")
	write := func(value string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(inline)
	for _, tc := range []struct {
		file string
		env  *string
	}{{"", nil}, {path, &inline}} {
		if _, err := Load(tc.file, tc.env, runtimeOptions); err == nil {
			t.Fatal("expected exactly one key source to be required")
		}
	}
	empty := ""
	if _, err := Load("", &empty, runtimeOptions); err == nil {
		t.Fatal("expected invalid inline JWKS")
	}
	keys, err := Load(path, nil, runtimeOptions)
	if err != nil {
		t.Fatal(err)
	}
	envKeys, err := Load("", &inline, runtimeOptions)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1700000000, 0)
	payload, _ := json.Marshal(claimsAt(now))
	oldToken := jwt(priv, []byte(`{"alg":"EdDSA","typ":"camelfs+jwt","kid":"old"}`), payload)
	newToken := jwt(nextPriv, []byte(`{"alg":"EdDSA","typ":"camelfs+jwt","kid":"new"}`), payload)
	check := func(keys *Keys, token string, want error) {
		t.Helper()
		if _, err := keys.Verify(token, now); !errors.Is(err, want) {
			t.Fatalf("Verify error = %v, want %v", err, want)
		}
	}

	write(jwks(nextKey, nextKey))
	if err := keys.Reload(); err == nil {
		t.Fatal("expected reload to reject duplicate kid")
	}
	check(keys, oldToken, nil)
	check(keys, newToken, UnknownKey)
	write(jwks(key, nextKey))
	if err := keys.Reload(); err != nil {
		t.Fatal(err)
	}
	check(keys, oldToken, nil)
	check(keys, newToken, nil)
	write(jwks(nextKey))
	if err := keys.Reload(); err != nil {
		t.Fatal(err)
	}
	check(keys, oldToken, UnknownKey)
	check(keys, newToken, nil)

	inline = jwks(nextKey)
	if err := envKeys.Reload(); err != nil {
		t.Fatal(err)
	}
	check(envKeys, oldToken, nil)
	check(envKeys, newToken, UnknownKey)
}
