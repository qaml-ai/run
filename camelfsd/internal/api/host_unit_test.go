package api

import (
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
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
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
	pub, key, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(2), NotBefore: ca.cert.NotBefore, NotAfter: ca.cert.NotAfter,
		ExtKeyUsage: []x509.ExtKeyUsage{usage}, KeyUsage: x509.KeyUsageDigitalSignature}
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

func certHeader(cert tls.Certificate) string {
	return url.PathEscape(string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]})))
}

func TestUnitHostIdentity(t *testing.T) {
	ca, other := newHostTestCA(t), newHostTestCA(t)
	auth := x509.ExtKeyUsageClientAuth
	valid := certHeader(ca.leaf(t, auth, hostSANPrefix+"a"))
	for _, tc := range []struct {
		name, path, header string
		status             int
	}{
		{"valid", "a", valid, 204},
		{"other CA", "a", certHeader(other.leaf(t, auth, hostSANPrefix+"a")), 403},
		{"tier", "a", certHeader(ca.leaf(t, auth, "spiffe://camelfs/tier")), 403},
		{"two URI SANs", "a", certHeader(ca.leaf(t, auth, hostSANPrefix+"a", hostSANPrefix+"b")), 403},
		{"mismatch", "b", valid, 403}, {"malformed", "a", "%ZZ", 401}, {"absent", "a", "", 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &HostServer{ca: func() *x509.CertPool { return ca.pool }}
			h := s.authenticated(func(w http.ResponseWriter, _ *http.Request, id string) error {
				if id != "a" {
					t.Errorf("id = %q", id)
				}
				w.WriteHeader(204)
				return nil
			})
			r := httptest.NewRequest("POST", "/v1/hosts/"+tc.path+"/heartbeat", nil)
			r.SetPathValue("host", tc.path)
			if tc.header != "" {
				r.Header.Set(leafHeader, tc.header)
			}
			w := httptest.NewRecorder()
			h(w, r)
			if w.Code != tc.status {
				t.Fatalf("HTTP %d: %s", w.Code, w.Body)
			}
		})
	}
}

func TestUnitHolderIdentity(t *testing.T) {
	ca := newHostTestCA(t)
	s := &HostServer{ca: func() *x509.CertPool { return ca.pool }, findHost: func(_ context.Context, _ []string, id string) (compute.Host, error) {
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
	r := httptest.NewRequest("POST", "/v1/hosts/b/stub-cas", strings.NewReader(`{"host":"a","boot":5,"mount":"vm"}`))
	r.Header.Set(leafHeader, certHeader(ca.leaf(t, x509.ExtKeyUsageClientAuth, hostSANPrefix+"b")))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("HTTP %d: %s", w.Code, w.Body)
	}
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
	p := HostPusher{CA: func() *x509.CertPool { return ca.pool }, Certificate: ca.leaf(t, x509.ExtKeyUsageClientAuth, "spiffe://camelfs/tier")}
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

func TestUnitComputeDisabled(t *testing.T) {
	storage := NewStorageServer(nil, "test-version", nil)
	handler := WithHostRoutes(storage, nil)
	for _, tc := range []struct {
		method, path string
		status       int
	}{
		{"POST", "/v1/hosts/a/register", 404}, {"GET", "/v0/health", 200}, {"GET", "/v1/lineages/a/trees/x", 401},
	} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Code != tc.status {
			t.Fatalf("%s: HTTP %d, %s", tc.path, w.Code, w.Body)
		}
	}
}
