package api

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"os"
	"slices"
	"sync/atomic"
)

// HostTLS holds the credentials shared by the host listener and outbound pushes.
type HostTLS struct {
	caFile, certFile, keyFile string
	current                   atomic.Pointer[tls.Config]
}

func LoadHostTLS(caFile, certFile, keyFile string) (*HostTLS, error) {
	h := &HostTLS{caFile: caFile, certFile: certFile, keyFile: keyFile}
	if err := h.Reload(); err != nil {
		return nil, err
	}
	return h, nil
}

func (h *HostTLS) Reload() error {
	raw, err := os.ReadFile(h.caFile)
	if err != nil {
		return err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(raw) {
		return errors.New("invalid hosts CA PEM bundle")
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
	h.current.Store(&tls.Config{
		MinVersion:   tls.VersionTLS12,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    pool,
		Certificates: []tls.Certificate{cert},
		// Require a fresh certificate verification even when a client offers resumption.
		SessionTicketsDisabled: true,
	})
	return nil
}

func (h *HostTLS) ServerConfig() *tls.Config {
	config := h.current.Load().Clone()
	config.GetConfigForClient = func(*tls.ClientHelloInfo) (*tls.Config, error) {
		return h.current.Load(), nil
	}
	return config
}
