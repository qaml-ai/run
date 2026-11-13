package auth

import (
	"encoding/json"
	"errors"
	"time"
)

const (
	BadHost Reason = "invalid host"
	BadVM   Reason = "vm must be a string"
)

type HostClaims struct {
	Subject, KeyID, Host string
	VM                   *string
	IssuedAt, ExpiresAt  int64
}

type HostKeys struct {
	keys   *Keys
	hostID string
}

// LoadHost pins the type, audience, and lifetime for grants to one host.
func LoadHost(path string, inline *string, issuer, hostID string) (*HostKeys, error) {
	if hostID == "" {
		return nil, errors.New("host id is required")
	}
	keys, err := Load(path, inline, Options{
		Typ: HostType, Audience: "camelfs:host:" + hostID, Issuer: issuer, MaxTTL: HostMaxTTL,
	})
	if err != nil {
		return nil, err
	}
	return &HostKeys{keys: keys, hostID: hostID}, nil
}

func (k *HostKeys) Verify(token string, now time.Time) (HostClaims, error) {
	env, err := k.keys.verifyEnvelope(token, now)
	if err != nil {
		return HostClaims{}, err
	}
	host := stringField(env.payload, "host")
	if host == "" || host != k.hostID {
		return HostClaims{}, BadHost
	}
	var vm *string
	if raw, ok := env.payload["vm"]; ok {
		if err := json.Unmarshal(raw, &vm); err != nil || vm == nil {
			return HostClaims{}, BadVM
		}
	}
	return HostClaims{
		Subject: env.Subject, KeyID: env.KeyID, IssuedAt: env.IssuedAt, ExpiresAt: env.ExpiresAt,
		Host: host, VM: vm,
	}, nil
}

func (k *HostKeys) Reload() error {
	return k.keys.Reload()
}
