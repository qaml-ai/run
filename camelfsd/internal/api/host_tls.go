package api

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"log/slog"
	"net/url"
	"os"
	"slices"
	"sync/atomic"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/hostcert"
)

// HostTLS holds the credentials shared by the host listener and outbound pushes.
type HostTLS struct {
	caFile, certFile, keyFile string
	current                   atomic.Pointer[hostTLSState]
}

type hostTLSState struct {
	*tls.Config
	caPEM string
}

func LoadHostTLS(caFile, certFile, keyFile string) (*HostTLS, error) {
	h := &HostTLS{caFile: caFile, certFile: certFile, keyFile: keyFile}
	if err := h.Reload(); err != nil {
		return nil, err
	}
	return h, nil
}

func (h *HostTLS) Reload() error {
	if h.caFile == "" {
		return nil
	}
	raw, err := os.ReadFile(h.caFile)
	if err != nil {
		return err
	}
	pool, err := hostCAPool(string(raw))
	if err != nil {
		return err
	}
	cert, err := tls.LoadX509KeyPair(h.certFile, h.keyFile)
	if err != nil {
		return err
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return err
	}
	if !slices.Contains(leaf.ExtKeyUsage, x509.ExtKeyUsageServerAuth) ||
		!slices.Contains(leaf.ExtKeyUsage, x509.ExtKeyUsageClientAuth) {
		return errors.New("tier certificate requires serverAuth and clientAuth EKUs")
	}
	h.store(cert, pool, string(raw))
	return nil
}

func (h *HostTLS) store(cert tls.Certificate, pool *x509.CertPool, caPEM string) {
	h.current.Store(&hostTLSState{Config: &tls.Config{
		MinVersion:   tls.VersionTLS12,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    pool,
		Certificates: []tls.Certificate{cert},
		// Require a fresh certificate verification even when a client offers resumption.
		SessionTicketsDisabled: true,
	}, caPEM: caPEM})
}

func (h *HostTLS) ServerConfig() *tls.Config {
	config := h.current.Load().Clone()
	config.GetConfigForClient = func(*tls.ClientHelloInfo) (*tls.Config, error) {
		return h.current.Load().Config, nil
	}
	return config
}

// EnrollServerConfig serves --listen-enroll: TLS with the tier's own Private-CA certificate (SAN spiffe://camelfs/tier),
// server authentication only. A new host has no certificate yet, so none is requested: it pins the Private CA and the
// tier SAN, and proves itself with its STS attestation in the request body. The certificate rotates with --listen-hosts.
func (h *HostTLS) EnrollServerConfig() *tls.Config {
	enroll := func() *tls.Config {
		current := h.current.Load().Config
		return &tls.Config{MinVersion: tls.VersionTLS12, ClientAuth: tls.NoClientCert, Certificates: current.Certificates,
			SessionTicketsDisabled: true}
	}
	config := enroll()
	config.GetConfigForClient = func(*tls.ClientHelloInfo) (*tls.Config, error) { return enroll(), nil }
	return config
}

func hostCAPool(caPEM string) (*x509.CertPool, error) {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(caPEM)) {
		return nil, errors.New("invalid hosts CA PEM bundle")
	}
	return pool, nil
}

func IssueHostTLS(ctx context.Context, issuer hostcert.Issuer) (*HostTLS, error) {
	caPEM, err := issuer.CACertificate(ctx)
	if err != nil {
		return nil, err
	}
	pool, err := hostCAPool(caPEM)
	if err != nil {
		return nil, err
	}
	cert, err := issueTierCert(ctx, issuer)
	if err != nil {
		return nil, err
	}
	h := &HostTLS{}
	h.store(cert, pool, caPEM)
	return h, nil
}

func issueTierCert(ctx context.Context, issuer hostcert.Issuer) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	uri, _ := url.Parse(hostcert.TierURI)
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{URIs: []*url.URL{uri}}, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	cert, chain, _, err := issuer.Issue(ctx, csr, hostcert.TierURI, hostcert.Lifetime, true)
	if err != nil {
		return tls.Certificate{}, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	pair, err := tls.X509KeyPair([]byte(cert+"\n"+chain), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	if err != nil {
		return tls.Certificate{}, err
	}
	if pair.Leaf == nil {
		pair.Leaf, err = x509.ParseCertificate(pair.Certificate[0])
		if err != nil {
			return tls.Certificate{}, err
		}
	}
	if err := hostcert.CheckLeaf(pair.Leaf, hostcert.TierURI); err != nil {
		return tls.Certificate{}, err
	}
	now := time.Now()
	if now.Before(pair.Leaf.NotBefore) || !now.Before(pair.Leaf.NotAfter) {
		return tls.Certificate{}, errors.New("tier certificate is outside its validity window")
	}
	return pair, nil
}

const tierRenewInterval = 8 * time.Hour

// Rotate keeps serving the last successful credentials through transient CA failures.
func (h *HostTLS) Rotate(ctx context.Context, issuer hostcert.Issuer) error {
	nextRenew := time.Now().Add(tierRenewInterval)
	nextRefresh := time.Now().Add(time.Hour)
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case now := <-ticker.C:
			h.rotateAt(ctx, issuer, now, &nextRenew, &nextRefresh)
		}
	}
}

func (h *HostTLS) rotateAt(ctx context.Context, issuer hostcert.Issuer, now time.Time, nextRenew, nextRefresh *time.Time) {
	if !now.Before(*nextRefresh) {
		*nextRefresh = now.Add(time.Hour)
		refresh, cancel := context.WithTimeout(ctx, 20*time.Second)
		caPEM, err := issuer.CACertificate(refresh)
		cancel()
		if err == nil {
			var pool *x509.CertPool
			pool, err = hostCAPool(caPEM)
			if err == nil {
				h.store(h.current.Load().Certificates[0], pool, caPEM)
			}
		}
		if err != nil {
			slog.Error("hosts_ca_refresh_failed", "error", err)
		}
	}
	current := h.current.Load()
	leaf := current.Certificates[0].Leaf
	if now.Before(*nextRenew) && now.Before(leaf.NotAfter.Add(-time.Hour)) {
		return
	}
	renew, cancel := context.WithTimeout(ctx, 30*time.Second)
	cert, err := issueTierCert(renew, issuer)
	cancel()
	if err == nil {
		h.store(cert, current.ClientCAs, current.caPEM)
		*nextRenew = now.Add(tierRenewInterval)
		return
	}
	slog.Error("tier_cert_renew_failed", "error", err)
	if !now.Before(leaf.NotAfter.Add(-time.Hour)) {
		slog.Error("tier_cert_expiring", "notAfter", leaf.NotAfter)
	}
}
