package auth

import (
	"crypto/ed25519"
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type Reason string

func (r Reason) Error() string { return string(r) }

const (
	TokenTooLarge Reason = "token exceeds 8 KiB"
	Malformed     Reason = "malformed token"
	BadAlgorithm  Reason = "alg must be EdDSA"
	BadType       Reason = "typ must be camelfs+jwt"
	BadHeader     Reason = "unsupported JWT header"
	MissingKey    Reason = "kid is required"
	UnknownKey    Reason = "unknown kid"
	BadSignature  Reason = "invalid signature"
	BadIssuer     Reason = "invalid issuer"
	BadAudience   Reason = "invalid audience"
	BadSubject    Reason = "sub must be a non-empty string"
	BadIssuedAt   Reason = "iat must be an integer"
	BadExpiration Reason = "exp must be an integer after iat"
	Expired       Reason = "token expired"
	Future        Reason = "iat is more than 5 seconds in the future"
	TooLong       Reason = "token lifetime exceeds the configured maximum"
	BadLineage    Reason = "lin must be a valid lineage"
	BadAccess     Reason = "acc must be r or w"
	BadRefs       Reason = "refs must be an array of at most 64 valid ref globs"
	BadFence      Reason = "fence must contain a string holder and integer epoch"
)

type Claims struct {
	Subject, Lineage, Access, KeyID string
	IssuedAt, ExpiresAt             int64
	Refs                            []string
	Fence                           *Fence
}

type Fence struct {
	Holder string
	Epoch  int64
}

var refGlob = regexp.MustCompile(`^[A-Za-z0-9._/*-]+$`)

func (k *Keys) Verify(token string, now time.Time) (Claims, error) {
	if len(token) > 8<<10 {
		return Claims{}, TokenTooLarge
	}
	h, rest, ok := strings.Cut(token, ".")
	p, s, separated := strings.Cut(rest, ".")
	if !ok || !separated {
		return Claims{}, Malformed
	}
	header, err := decodeSegment(h)
	if err != nil {
		return Claims{}, Malformed
	}
	fields, err := jsonObject(header)
	if err != nil {
		return Claims{}, Reason("invalid JWT header: " + err.Error())
	}
	if stringField(fields, "alg") != "EdDSA" {
		return Claims{}, BadAlgorithm
	}
	if stringField(fields, "typ") != "camelfs+jwt" {
		return Claims{}, BadType
	}
	for _, name := range []string{"jwk", "jku", "x5u", "crit"} {
		if _, ok := fields[name]; ok {
			return Claims{}, BadHeader
		}
	}
	kid := stringField(fields, "kid")
	if kid == "" {
		return Claims{}, MissingKey
	}
	pub := (*k.active.Load())[kid]
	if pub == nil {
		return Claims{}, UnknownKey
	}
	payload, err := decodeSegment(p)
	if err != nil {
		return Claims{}, Malformed
	}
	sig, err := decodeSegment(s)
	if err != nil {
		return Claims{}, Malformed
	}
	if !ed25519.Verify(pub, []byte(token[:len(h)+1+len(p)]), sig) {
		return Claims{}, BadSignature
	}
	return k.claims(payload, kid, now)
}

func (k *Keys) claims(raw []byte, kid string, now time.Time) (Claims, error) {
	obj, err := jsonObject(raw)
	if err != nil {
		return Claims{}, Reason("invalid JWT payload: " + err.Error())
	}
	if stringField(obj, "iss") != k.issuer {
		return Claims{}, BadIssuer
	}
	if stringField(obj, "aud") != "camelrun:camelfs" {
		return Claims{}, BadAudience
	}
	sub := stringField(obj, "sub")
	if sub == "" {
		return Claims{}, BadSubject
	}
	iat, ok := integerField(obj, "iat")
	if !ok {
		return Claims{}, BadIssuedAt
	}
	exp, ok := integerField(obj, "exp")
	if !ok || exp <= iat {
		return Claims{}, BadExpiration
	}
	if exp <= now.Unix() {
		return Claims{}, Expired
	}
	if iat > now.Add(5*time.Second).Unix() {
		return Claims{}, Future
	}
	// Subtract as unsigned after checking the order, avoiding int64 overflow.
	if uint64(exp)-uint64(iat) > uint64(k.maxTTL/time.Second) {
		return Claims{}, TooLong
	}
	lin, acc := stringField(obj, "lin"), stringField(obj, "acc")
	if !store.Lineage(lin) {
		return Claims{}, BadLineage
	}
	if acc != "r" && acc != "w" {
		return Claims{}, BadAccess
	}
	var refs []string
	if json.Unmarshal(obj["refs"], &refs) != nil || refs == nil || len(refs) > 64 {
		return Claims{}, BadRefs
	}
	for _, glob := range refs {
		if !refGlob.MatchString(glob) {
			return Claims{}, BadRefs
		}
	}
	var fence *Fence
	if value, ok := obj["fence"]; ok {
		fields, err := jsonObject(value)
		var holder *string
		epoch, valid := integerField(fields, "epoch")
		if err != nil || json.Unmarshal(fields["holder"], &holder) != nil || holder == nil || !valid {
			return Claims{}, BadFence
		}
		fence = &Fence{Holder: *holder, Epoch: epoch}
	}
	return Claims{Subject: sub, Lineage: lin, Access: acc, KeyID: kid, IssuedAt: iat, ExpiresAt: exp, Refs: refs, Fence: fence}, nil
}
