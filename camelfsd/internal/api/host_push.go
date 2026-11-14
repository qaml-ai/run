package api

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
)

type HostPusher struct {
	TLS *HostTLS
}

func (p HostPusher) Boot(ctx context.Context, host compute.Host, spec hostwire.BootSpec) error {
	return p.post(ctx, host, "/v1/vms", spec)
}

func (p HostPusher) Stop(ctx context.Context, host compute.Host, id string, checkpoint bool) error {
	return p.post(ctx, host, "/v1/vms/"+url.PathEscape(id)+"/stop", hostwire.Stop{Checkpoint: checkpoint})
}

func validHostAddr(addr string) bool {
	host, port, err := net.SplitHostPort(addr)
	n, portErr := strconv.ParseUint(port, 10, 16)
	return err == nil && host != "" && !strings.ContainsAny(host, "/\\?#@% \t\r\n") && portErr == nil && n > 0
}

func (p HostPusher) post(ctx context.Context, host compute.Host, path string, body any) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, err := p.request(ctx, host, http.MethodPost, path, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("host returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func (p HostPusher) request(ctx context.Context, host compute.Host, method, path string, body any) (*http.Response, error) {
	if !validHostAddr(host.Addr) {
		return nil, errors.New("invalid host address")
	}
	if p.TLS == nil || p.TLS.current.Load() == nil {
		return nil, errors.New("host TLS unavailable")
	}
	var input io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		input = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, "https://"+host.Addr+path, input)
	if err != nil {
		return nil, err
	}
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	transport := &http.Transport{DisableKeepAlives: true, TLSClientConfig: p.tlsConfig(host.Host)}
	client := http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	return client.Do(req)
}

func (p HostPusher) tlsConfig(hostID string) *tls.Config {
	// A push uses one fresh connection. Both TLS callbacks must use the
	// same snapshot even if the tier rotates between them.
	credentials := sync.OnceValue(p.TLS.current.Load)
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			return &credentials().Certificates[0], nil
		},
		// Verify the private chain and SPIFFE URI in place of DNS verification.
		InsecureSkipVerify: true,
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return errHostCertificateMissing
			}
			leaf, err := x509.ParseCertificate(rawCerts[0])
			if err != nil {
				return err
			}
			chain := x509.NewCertPool()
			for _, raw := range rawCerts[1:] {
				cert, err := x509.ParseCertificate(raw)
				if err != nil {
					return err
				}
				chain.AddCert(cert)
			}
			return verifyHostCertificate(leaf, chain, credentials().ClientCAs, x509.ExtKeyUsageServerAuth, hostID)
		},
	}
}
