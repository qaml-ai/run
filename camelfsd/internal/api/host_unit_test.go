package api

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type hostTestCA struct {
	cert *x509.Certificate
	key  ed25519.PrivateKey
	pool *x509.CertPool
}

func newHostTestCA(t *testing.T) hostTestCA {
	t.Helper()
	pub, key, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		BasicConstraintsValid: true, IsCA: true, KeyUsage: x509.KeyUsageCertSign}
	raw, err := x509.CreateCertificate(nil, tmpl, tmpl, pub, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(raw)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return hostTestCA{cert, key, pool}
}

func (ca hostTestCA) leaf(t *testing.T, usage x509.ExtKeyUsage, sans ...string) tls.Certificate {
	t.Helper()
	usages := []x509.ExtKeyUsage{usage}
	if len(sans) == 1 && sans[0] == "spiffe://camelfs/tier" {
		usages = append(usages, x509.ExtKeyUsageServerAuth)
	}
	return ca.leafWithValidity(t, usages, ca.cert.NotBefore, ca.cert.NotAfter, sans...)
}

func (ca hostTestCA) leafWithValidity(t *testing.T, usages []x509.ExtKeyUsage, from, until time.Time, sans ...string) tls.Certificate {
	t.Helper()
	pub, key, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(2), NotBefore: from, NotAfter: until,
		ExtKeyUsage: usages, KeyUsage: x509.KeyUsageDigitalSignature, IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)}}
	for _, san := range sans {
		uri, err := url.Parse(san)
		if err != nil {
			t.Fatal(err)
		}
		tmpl.URIs = append(tmpl.URIs, uri)
	}
	raw, err := x509.CreateCertificate(nil, tmpl, ca.cert, pub, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{raw}, PrivateKey: key}
}

func writeHostTLS(t *testing.T, ca hostTestCA, cert tls.Certificate, dir string) (string, string, string) {
	t.Helper()
	caFile, certFile, keyFile := filepath.Join(dir, "ca.pem"), filepath.Join(dir, "tier.pem"), filepath.Join(dir, "tier-key.pem")
	key, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	for path, block := range map[string]pem.Block{
		caFile:   {Type: "CERTIFICATE", Bytes: ca.cert.Raw},
		certFile: {Type: "CERTIFICATE", Bytes: cert.Certificate[0]},
		keyFile:  {Type: "PRIVATE KEY", Bytes: key},
	} {
		if err := os.WriteFile(path, pem.EncodeToMemory(&block), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return caFile, certFile, keyFile
}

func testHostTLS(t *testing.T, ca hostTestCA, tierCert tls.Certificate, dir string) *HostTLS {
	t.Helper()
	caFile, certFile, keyFile := writeHostTLS(t, ca, tierCert, dir)
	credentials, err := LoadHostTLS(caFile, certFile, keyFile)
	if err != nil {
		t.Fatal(err)
	}
	return credentials
}

func testTier(t *testing.T, credentials *HostTLS, handler http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.TLS = credentials.ServerConfig()
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}

func testHostClient(t *testing.T, ca *x509.CertPool, certs ...tls.Certificate) *http.Client {
	t.Helper()
	config := &tls.Config{RootCAs: ca}
	if len(certs) > 0 {
		// Send the test certificate even if its issuer isn't advertised by the server.
		config.GetClientCertificate = func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			return &certs[0], nil
		}
	}
	transport := &http.Transport{TLSClientConfig: config, DisableKeepAlives: true}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 5 * time.Second}
}

func TestUnitHostIdentity(t *testing.T) {
	ca, other := newHostTestCA(t), newHostTestCA(t)
	auth := x509.ExtKeyUsageClientAuth
	tierCert := ca.leaf(t, auth, "spiffe://camelfs/tier")
	certA := ca.leaf(t, auth, hostSANPrefix+"a")
	certB := ca.leaf(t, auth, hostSANPrefix+"b")
	s := NewHostServer(&compute.Controller{Objects: store.Local{}}, nil, time.Minute)
	// Exercise the authentication wrapper without a DynamoDB controller.
	s.routes.HandleFunc("POST /v1/hosts/{host}/stub", s.authenticated(func(w http.ResponseWriter, _ *http.Request, _ string) error {
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))
	tier := testTier(t, testHostTLS(t, ca, tierCert, t.TempDir()), s)
	now := time.Now()
	for _, tc := range []struct {
		name, path string
		certs      []tls.Certificate
		forged     bool
		status     int
	}{
		{name: "valid", path: "/v1/hosts/a/stub", certs: []tls.Certificate{certA}, status: 204},
		{name: "real host route", path: "/v1/hosts/a/register", certs: []tls.Certificate{certA}, status: 400},
		{name: "missing cert", path: "/v1/hosts/a/stub"},
		{name: "other CA", path: "/v1/hosts/a/stub", certs: []tls.Certificate{other.leaf(t, auth, hostSANPrefix+"a")}},
		{name: "expired", path: "/v1/hosts/a/stub", certs: []tls.Certificate{ca.leafWithValidity(t, []x509.ExtKeyUsage{auth}, now.Add(-30*time.Minute), now.Add(-time.Minute), hostSANPrefix+"a")}},
		{name: "not yet valid", path: "/v1/hosts/a/stub", certs: []tls.Certificate{ca.leafWithValidity(t, []x509.ExtKeyUsage{auth}, now.Add(time.Minute), now.Add(30*time.Minute), hostSANPrefix+"a")}},
		{name: "missing explicit client EKU", path: "/v1/hosts/a/stub", certs: []tls.Certificate{ca.leafWithValidity(t, nil, ca.cert.NotBefore, ca.cert.NotAfter, hostSANPrefix+"a")}, status: 403},
		{name: "tier SAN", path: "/v1/hosts/a/stub", certs: []tls.Certificate{tierCert}, status: 403},
		{name: "two URI SANs", path: "/v1/hosts/a/stub", certs: []tls.Certificate{ca.leaf(t, auth, hostSANPrefix+"a", hostSANPrefix+"b")}, status: 403},
		{name: "mismatch", path: "/v1/hosts/a/stub", certs: []tls.Certificate{certB}, status: 403},
		{name: "forged header", path: "/v1/hosts/a/stub", certs: []tls.Certificate{certB}, forged: true, status: 403},
		{name: "storage", path: "/v1/lineages/a/trees/x", certs: []tls.Certificate{certA}, status: 404},
		{name: "health", path: "/v0/health", certs: []tls.Certificate{certA}, status: 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, tier.URL+tc.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			if tc.name == "health" || tc.name == "storage" {
				req.Method = http.MethodGet
			}
			if tc.forged {
				req.Header.Set("X-Amzn-Mtls-Clientcert-Leaf", url.PathEscape(string(pem.EncodeToMemory(
					&pem.Block{Type: "CERTIFICATE", Bytes: certA.Certificate[0]}))))
			}
			resp, err := testHostClient(t, ca.pool, tc.certs...).Do(req)
			if err != nil && tc.status == 0 {
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.status {
				t.Fatalf("HTTP %d, want %d", resp.StatusCode, tc.status)
			}
		})
	}
}

func TestUnitHolderIdentity(t *testing.T) {
	ca := newHostTestCA(t)
	s := &HostServer{findHost: func(_ context.Context, _ []string, id string) (compute.Host, error) {
		return compute.Host{HostInfo: compute.HostInfo{Host: id}, BootEpoch: 5}, nil
	}}
	holder := hostwire.Holder{Host: "a", Boot: 5, Mount: "vm"}
	if err := s.checkHolder(t.Context(), "a", holder); err != nil {
		t.Fatal(err)
	}
	if err := s.checkHolder(t.Context(), "b", holder); !errors.Is(err, errHostForbidden) {
		t.Fatal(err)
	}
	if err := s.checkHolder(t.Context(), "a", hostwire.Holder{Host: "a", Boot: 4, Mount: "vm"}); !errors.Is(err, errHostForbidden) {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/hosts/{host}/stub-cas", s.authenticated(func(w http.ResponseWriter, r *http.Request, host string) error {
		var h hostwire.Holder
		if err := readHostRequest(w, r, &h); err != nil {
			return err
		}
		if err := s.checkHolder(r.Context(), host, h); err != nil {
			return err
		}
		w.WriteHeader(204)
		return nil
	}))
	tierCert := ca.leaf(t, x509.ExtKeyUsageClientAuth, "spiffe://camelfs/tier")
	tier := testTier(t, testHostTLS(t, ca, tierCert, t.TempDir()), mux)
	client := testHostClient(t, ca.pool, ca.leaf(t, x509.ExtKeyUsageClientAuth, hostSANPrefix+"b"))
	resp, err := client.Post(tier.URL+"/v1/hosts/b/stub-cas", "application/json",
		strings.NewReader(`{"host":"a","boot":5,"mount":"vm"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("HTTP %d", resp.StatusCode)
	}
}

func TestUnitHostTLSReload(t *testing.T) {
	oldCA, newCA := newHostTestCA(t), newHostTestCA(t)
	auth := x509.ExtKeyUsageClientAuth
	oldTier := oldCA.leaf(t, auth, "spiffe://camelfs/tier")
	newTier := newCA.leaf(t, auth, "spiffe://camelfs/tier")
	dir := t.TempDir()
	credentials := testHostTLS(t, oldCA, oldTier, dir)
	s := &HostServer{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/hosts/{host}/stub", s.authenticated(func(w http.ResponseWriter, _ *http.Request, _ string) error {
		w.WriteHeader(204)
		return nil
	}))
	tier := testTier(t, credentials, mux)
	roots := oldCA.pool.Clone()
	roots.AddCert(newCA.cert)
	oldClient := testHostClient(t, roots, oldCA.leaf(t, auth, hostSANPrefix+"a"))
	newClient := testHostClient(t, roots, newCA.leaf(t, auth, hostSANPrefix+"a"))
	check := func(client *http.Client, want tls.Certificate, accept bool) {
		t.Helper()
		resp, err := client.Post(tier.URL+"/v1/hosts/a/stub", "application/json", nil)
		if err != nil && !accept {
			return
		}
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if !accept || resp.StatusCode != 204 || !bytes.Equal(resp.TLS.PeerCertificates[0].Raw, want.Certificate[0]) {
			t.Fatalf("unexpected response (accept=%v): HTTP %d", accept, resp.StatusCode)
		}
	}
	check(oldClient, oldTier, true)
	check(newClient, oldTier, false)
	_, _, keyFile := writeHostTLS(t, newCA, newTier, dir)
	if err := os.WriteFile(keyFile, []byte("invalid key"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := credentials.Reload(); err == nil {
		t.Fatal("reload accepted invalid key")
	}
	check(oldClient, oldTier, true)
	writeHostTLS(t, newCA, newTier, dir)
	if err := credentials.Reload(); err != nil {
		t.Fatal(err)
	}
	check(newClient, newTier, true)
	check(oldClient, newTier, false)
}

func fakeHostTLS(t *testing.T, ca hostTestCA, serverCert tls.Certificate, handler http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: ca.pool,
		VerifyConnection: func(cs tls.ConnectionState) error {
			uris := cs.PeerCertificates[0].URIs
			if len(uris) != 1 || uris[0].String() != "spiffe://camelfs/tier" {
				return errHostForbidden
			}
			return nil
		}}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}

func TestUnitHostPushIdentity(t *testing.T) {
	ca, other := newHostTestCA(t), newHostTestCA(t)
	p := HostPusher{TLS: testHostTLS(t, ca, ca.leaf(t, x509.ExtKeyUsageClientAuth, "spiffe://camelfs/tier"), t.TempDir())}
	for _, tc := range []struct {
		name string
		ca   hostTestCA
		san  string
		ok   bool
	}{
		{"correct", ca, hostSANPrefix + "a", true},
		{"wrong SAN", ca, hostSANPrefix + "b", false},
		{"wrong CA", other, hostSANPrefix + "a", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			left, right := net.Pipe()
			defer left.Close()
			defer right.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
			defer cancel()
			server := tls.Server(left, &tls.Config{
				Certificates: []tls.Certificate{tc.ca.leaf(t, x509.ExtKeyUsageServerAuth, tc.san)},
				ClientAuth:   tls.RequireAndVerifyClientCert, ClientCAs: ca.pool,
			})
			serverDone := make(chan error, 1)
			go func() { serverDone <- server.HandshakeContext(ctx) }()
			err := tls.Client(right, p.tlsConfig("a")).HandshakeContext(ctx)
			if tc.ok {
				if serverErr := <-serverDone; serverErr != nil {
					t.Fatalf("tier client certificate: %v", serverErr)
				}
			}
			if (err == nil) != tc.ok {
				t.Fatalf("push error: %v", err)
			}
		})
	}
}

func TestUnitStorageListener(t *testing.T) {
	storage := NewStorageServer(nil, "test-version", nil)
	for _, suffix := range []string{"register", "heartbeat", "vms/x/started", "vms/x/ended"} {
		for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch,
			http.MethodDelete, http.MethodConnect, http.MethodOptions, http.MethodTrace, "OTHER"} {
			w := httptest.NewRecorder()
			storage.ServeHTTP(w, httptest.NewRequest(method, "/v1/hosts/a/"+suffix, nil))
			if w.Code != 404 {
				t.Errorf("%s %s: HTTP %d, want 404", method, suffix, w.Code)
			}
		}
	}
	for _, tc := range []struct {
		method, path string
		status       int
	}{
		{"GET", "/v0/health", 200}, {"GET", "/v1/lineages/a/trees/x", 401},
	} {
		w := httptest.NewRecorder()
		storage.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Code != tc.status {
			t.Fatalf("%s: HTTP %d, %s", tc.path, w.Code, w.Body)
		}
	}
}

func TestUnitEnrollListenerTLS(t *testing.T) {
	oldCA, newCA := newHostTestCA(t), newHostTestCA(t)
	oldTier := oldCA.leaf(t, x509.ExtKeyUsageClientAuth, "spiffe://camelfs/tier")
	newTier := newCA.leaf(t, x509.ExtKeyUsageClientAuth, "spiffe://camelfs/tier")
	dir := t.TempDir()
	credentials := testHostTLS(t, oldCA, oldTier, dir)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || len(r.TLS.PeerCertificates) != 0 {
			t.Errorf("enrollment must be TLS without a client certificate")
		}
		w.WriteHeader(204)
	}))
	server.TLS = credentials.EnrollServerConfig()
	server.StartTLS()
	t.Cleanup(server.Close)
	// A new host has no certificate: it pins the tier's certificate (here by its exact bytes) and presents none.
	served := func() []byte {
		t.Helper()
		var got []byte
		client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true, TLSClientConfig: &tls.Config{
			InsecureSkipVerify:    true, // the test checks the served leaf itself
			VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error { got = raw[0]; return nil },
		}}}
		resp, err := client.Post(server.URL+"/v1/hosts/enroll", "application/json", nil)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 204 {
			t.Fatalf("HTTP %d", resp.StatusCode)
		}
		return got
	}
	if !bytes.Equal(served(), oldTier.Certificate[0]) {
		t.Fatal("enroll listener does not serve the tier certificate")
	}
	writeHostTLS(t, newCA, newTier, dir)
	if err := credentials.Reload(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(served(), newTier.Certificate[0]) {
		t.Fatal("enroll listener did not pick up the rotated tier certificate")
	}
	// Plain HTTP to the TLS listener is refused.
	if resp, err := http.Post(strings.Replace(server.URL, "https://", "http://", 1)+"/v1/hosts/enroll", "application/json", nil); err == nil {
		resp.Body.Close()
		if resp.StatusCode < 400 {
			t.Fatalf("plain HTTP accepted: %d", resp.StatusCode)
		}
	}
}
