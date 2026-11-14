package api

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
)

type HostPusher struct {
	CA          func() *x509.CertPool
	Certificate tls.Certificate
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
	if !validHostAddr(host.Addr) {
		return errors.New("invalid host address")
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+host.Addr+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	transport := &http.Transport{DisableKeepAlives: true, TLSClientConfig: p.tlsConfig(host.Host)}
	client := http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("host returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func (p HostPusher) tlsConfig(hostID string) *tls.Config {
	return &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{p.Certificate},
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
			return verifyHostCertificate(leaf, chain, p.CA(), x509.ExtKeyUsageServerAuth, hostID)
		},
	}
}
