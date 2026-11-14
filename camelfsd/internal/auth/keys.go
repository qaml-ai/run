// Package auth verifies camelFS runtime and host grants.
package auth

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

const (
	DefaultMaxTTL   = 15 * time.Minute
	RuntimeType     = "camelfs+jwt"
	RuntimeAudience = "camelrun:camelfs"
)

type Options struct {
	Typ, Audience, Issuer string
	MaxTTL                time.Duration
}

type keySet map[string]ed25519.PublicKey

type Keys struct {
	path    string
	options Options
	active  atomic.Pointer[keySet]
}

func Load(path string, inline *string, options Options) (*Keys, error) {
	if (path != "") == (inline != nil) {
		return nil, errors.New("set exactly one of --jwks-file or CAMELFS_JWKS")
	}
	if options.Issuer == "" || options.MaxTTL <= 0 {
		return nil, errors.New("token-issuer and a positive token-max-ttl are required")
	}
	if options.Typ == "" || options.Audience == "" {
		return nil, errors.New("token type and audience are required")
	}
	k := &Keys{path: path, options: options}
	var err error
	if inline != nil {
		err = k.load([]byte(*inline))
	} else {
		err = k.Reload()
	}
	if err != nil {
		return nil, err
	}
	return k, nil
}

// Reload publishes the entire new set only after validating every key.
func (k *Keys) Reload() error {
	if k.path == "" {
		return nil
	}
	raw, err := os.ReadFile(k.path)
	if err != nil {
		return fmt.Errorf("read JWKS: %w", err)
	}
	return k.load(raw)
}

func (k *Keys) load(raw []byte) error {
	var keys []map[string]json.RawMessage
	obj, err := jsonObject(raw)
	if err != nil || json.Unmarshal(obj["keys"], &keys) != nil || len(keys) == 0 {
		return errors.New("invalid JWKS: expected a non-empty keys array")
	}
	next := make(keySet, len(keys))
	for i, key := range keys {
		kid := stringField(key, "kid")
		x, err := decodeSegment(stringField(key, "x"))
		_, private := key["d"]
		if kid == "" || private || stringField(key, "kty") != "OKP" || stringField(key, "crv") != "Ed25519" ||
			stringField(key, "alg") != "EdDSA" || stringField(key, "use") != "sig" || err != nil || len(x) != ed25519.PublicKeySize {
			return fmt.Errorf("invalid JWKS key at index %d", i)
		}
		if _, exists := next[kid]; exists {
			return fmt.Errorf("duplicate JWKS kid at index %d", i)
		}
		next[kid] = ed25519.PublicKey(x)
	}
	k.active.Store(&next)
	return nil
}

func decodeSegment(segment string) ([]byte, error) {
	if segment == "" || strings.ContainsAny(segment, "\r\n") {
		return nil, errors.New("invalid base64url")
	}
	return base64.RawURLEncoding.Strict().DecodeString(segment)
}
