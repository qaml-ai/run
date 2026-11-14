package computehost

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/hostcert"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
)

type testCA struct {
	leaf *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  string
}

func makeCA(t *testing.T) testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	leaf := &x509.Certificate{SerialNumber: big.NewInt(1), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(48 * time.Hour)}
	raw, err := x509.CreateCertificate(rand.Reader, leaf, leaf, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err = x509.ParseCertificate(raw)
	if err != nil {
		t.Fatal(err)
	}
	return testCA{leaf, key, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw}))}
}

func (ca testCA) issue(t *testing.T, uri string, serial int64, pub any) []byte {
	t.Helper()
	var names []*url.URL
	if uri != "" {
		u, err := url.Parse(uri)
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, u)
	}
	now := time.Now()
	raw, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: big.NewInt(serial), NotBefore: now.Add(-time.Minute), NotAfter: now.Add(24 * time.Hour), URIs: names,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		KeyUsage:    x509.KeyUsageDigitalSignature,
	}, ca.leaf, pub, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func (ca testCA) pair(t *testing.T, uri string) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{ca.issue(t, uri, 2, &key.PublicKey)}, PrivateKey: key}
}

func TestEnrollmentRenewalAndComputeTLS(t *testing.T) {
	testIdentity(t)
}

func testIdentity(t *testing.T) (*Identity, tls.Certificate) {
	t.Helper()
	const id = "i-0123456789abcdef0"
	ca := makeCA(t)
	tierPair := ca.pair(t, hostcert.TierURI)
	roots := x509.NewCertPool()
	roots.AddCert(ca.leaf)
	issued := int64(10)
	issue := func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			CSR         string
			Pool        string
			Attestation attestation
		}
		if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		block, _ := pem.Decode([]byte(q.CSR))
		if block == nil {
			t.Error("missing CSR")
			w.WriteHeader(400)
			return
		}
		csr, err := x509.ParseCertificateRequest(block.Bytes)
		if err != nil || csr.CheckSignature() != nil || len(csr.URIs) != 1 || csr.URIs[0].String() != hostURI+id {
			t.Errorf("invalid CSR: %v", err)
			w.WriteHeader(400)
			return
		}
		if r.URL.Path == "/v1/hosts/enroll" && (q.Pool != "test" || q.Attestation.Kind != "aws") {
			t.Error("missing enrollment data")
		}
		raw := ca.issue(t, hostURI+id, issued, csr.PublicKey)
		issued++
		leaf, err := x509.ParseCertificate(raw)
		if err != nil {
			t.Error(err)
			w.WriteHeader(500)
			return
		}
		jsonReply(w, 200, hostwire.Enrolled{HostID: id, CAPEM: ca.pem, NotAfter: leaf.NotAfter.UnixMilli(),
			CertificatePEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw}))})
	}
	enroll := httptest.NewTLSServer(http.HandlerFunc(issue))
	t.Cleanup(enroll.Close)
	tier := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaf := r.TLS.VerifiedChains[0][0]
		if err := hostcert.CheckLeaf(leaf, hostURI+id); err != nil {
			t.Error(err)
		}
		switch r.URL.Path {
		case "/v1/hosts/" + id + "/renew":
			issue(w, r)
		default:
			jsonReply(w, 200, leaf.SerialNumber.Int64())
		}
	}))
	tier.TLS = &tls.Config{Certificates: []tls.Certificate{tierPair}, ClientCAs: roots, ClientAuth: tls.RequireAndVerifyClientCert}
	tier.StartTLS()
	t.Cleanup(tier.Close)
	dir := t.TempDir()
	identity, err := newIdentity(t.Context(), dir, id, "test", strings.TrimPrefix(tier.URL, "https://"), enroll.URL,
		func(_ context.Context) (attestation, error) { return attestation{Kind: "aws"}, nil }, enroll.Client())
	if err != nil {
		t.Fatal(err)
	}
	key, err := os.Stat(filepath.Join(dir, "host-key.pem"))
	if err != nil || key.Mode().Perm() != 0600 {
		t.Fatalf("key: %v %v", key, err)
	}
	host := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
	host.TLS = identity.ServerTLS()
	host.StartTLS()
	t.Cleanup(host.Close)
	clientSerial := func() int64 {
		t.Helper()
		var serial int64
		if err := identity.Post(t.Context(), "/register", struct{}{}, &serial); err != nil {
			t.Fatal(err)
		}
		return serial
	}
	connect := func(pair tls.Certificate) (int64, error) {
		client := http.Client{Transport: &http.Transport{DisableKeepAlives: true, TLSClientConfig: &tls.Config{
			Certificates: []tls.Certificate{pair}, InsecureSkipVerify: true,
			VerifyConnection: func(cs tls.ConnectionState) error {
				if err := hostcert.CheckLeaf(cs.PeerCertificates[0], hostURI+id); err != nil {
					return err
				}
				return verifyPeer(cs.PeerCertificates[0], nil, roots, x509.ExtKeyUsageServerAuth)
			},
		}}}
		resp, err := client.Get(host.URL)
		if err != nil {
			return 0, err
		}
		resp.Body.Close()
		return resp.TLS.PeerCertificates[0].SerialNumber.Int64(), nil
	}
	for name, pair := range map[string]tls.Certificate{
		"missing SAN": ca.pair(t, ""),
		"host SAN":    ca.pair(t, hostURI+id),
		"wrong CA":    makeCA(t).pair(t, hostcert.TierURI),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := connect(pair); err == nil {
				t.Error("handshake succeeded")
			}
		})
	}
	for _, want := range []int64{10, 11} {
		if have := clientSerial(); have != want {
			t.Fatalf("outbound client serial %d want %d", have, want)
		}
		if have, err := connect(tierPair); err != nil || have != want {
			t.Fatalf("inbound server serial %d want %d: %v", have, want, err)
		}
		if want == 10 {
			if err := identity.issue(t.Context(), false); err != nil {
				t.Fatal(err)
			}
		}
	}
	return identity, tierPair
}
