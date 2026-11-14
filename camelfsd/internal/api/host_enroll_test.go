package api

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/hostcert"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

const enrollmentHost = "i-0123456789abcdef0"
const enrollmentAudience = "camelfs:enroll"
const enrollmentARN = "arn:aws:sts::123456789012:assumed-role/host/" + enrollmentHost
const enrollPath = "/v1/hosts/enroll"

type fakeHostIssuer struct {
	hostTestCA
	issued atomic.Int64
	fail   bool
	bundle string
}

func (f *fakeHostIssuer) CACertificate(context.Context) (string, error) {
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: f.cert.Raw})) + f.bundle, nil
}

func (f *fakeHostIssuer) Issue(_ context.Context, der []byte, uri string, validity time.Duration, both bool) (string, string, time.Time, error) {
	if f.fail {
		return "", "", time.Time{}, errors.New("issuer unavailable")
	}
	if validity != hostcert.Lifetime || !both {
		return "", "", time.Time{}, errors.New("unexpected issuance policy")
	}
	if err := hostcert.CheckCSR(der, uri); err != nil {
		return "", "", time.Time{}, err
	}
	csr, err := x509.ParseCertificateRequest(der)
	if err != nil {
		return "", "", time.Time{}, err
	}
	now := time.Now().Truncate(time.Second)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(f.issued.Add(1) + 10),
		NotBefore:    now.Add(-time.Minute), NotAfter: now.Add(validity),
		URIs: csr.URIs, Subject: csr.Subject,
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
	}
	raw, err := x509.CreateCertificate(rand.Reader, template, f.cert, csr.PublicKey, f.key)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw})), "", template.NotAfter, err
}

func enrollCSR(t *testing.T, uri string, dns []string, badSignature bool) (string, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	san, err := url.Parse(uri)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: "different-name"}, URIs: []*url.URL{san}, DNSNames: dns,
	}, key)
	if err != nil {
		t.Fatal(err)
	}
	if badSignature {
		raw[len(raw)-1] ^= 1
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: raw})),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
}

type fakeSTS func(context.Context, string, map[string]string, string) (int, []byte, error)

func (f fakeSTS) Do(ctx context.Context, url string, headers map[string]string, body string) (int, []byte, error) {
	return f(ctx, url, headers, body)
}

func attestationAt(now time.Time) awsAttestation {
	return awsAttestation{Kind: "aws", Method: "POST", URL: "https://sts.us-west-2.amazonaws.com/", Body: stsBody,
		Headers: map[string]string{"Host": "sts.us-west-2.amazonaws.com", audienceHeader: enrollmentAudience,
			"X-Amz-Date":           now.UTC().Format(amzDateFormat),
			"Authorization":        "AWS4-HMAC-SHA256 SignedHeaders=host;x-amz-date;" + audienceHeader + ", Signature=fake",
			"x-amz-security-token": "fake", "content-type": "application/x-www-form-urlencoded", "X-Amzn-Mtls-Clientcert-Leaf": "untrusted"},
	}
}

func TestUnitCheckAWSAttestation(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	for _, tc := range []struct {
		name   string
		change func(*awsAttestation)
	}{
		{"method", func(a *awsAttestation) { a.Method = "GET" }},
		{"scheme", func(a *awsAttestation) { a.URL = "http://sts.amazonaws.com/" }},
		{"endpoint", func(a *awsAttestation) { a.URL = "https://sts.amazonaws.com.example.com/" }},
		{"port", func(a *awsAttestation) { a.URL = "https://sts.amazonaws.com:444/" }},
		{"credentials", func(a *awsAttestation) { a.URL = "https://me@sts.amazonaws.com/" }},
		{"path", func(a *awsAttestation) { a.URL += "elsewhere" }},
		{"query", func(a *awsAttestation) { a.URL += "?Action=AssumeRole" }},
		{"body", func(a *awsAttestation) { a.Body += "&Action=AssumeRole" }},
		{"signed host mismatch", func(a *awsAttestation) { a.Headers["Host"] = "sts.amazonaws.com" }},
		{"audience mismatch", func(a *awsAttestation) { a.Headers[audienceHeader] = "different" }},
		{"unsigned audience", func(a *awsAttestation) { a.Headers["Authorization"] = "AWS4-HMAC-SHA256 SignedHeaders=host;x-amz-date" }},
		{"unsigned host", func(a *awsAttestation) {
			a.Headers["Authorization"] = "AWS4-HMAC-SHA256 SignedHeaders=x-amz-date;" + audienceHeader
		}},
		{"unsigned date", func(a *awsAttestation) {
			a.Headers["Authorization"] = "AWS4-HMAC-SHA256 SignedHeaders=host;" + audienceHeader
		}},
		{"auth scheme", func(a *awsAttestation) {
			a.Headers["Authorization"] = "Basic SignedHeaders=host;x-amz-date;" + audienceHeader
		}},
		{"invalid date", func(a *awsAttestation) { a.Headers["X-Amz-Date"] = "yesterday" }},
		{"stale date", func(a *awsAttestation) {
			a.Headers["X-Amz-Date"] = now.Add(-5*time.Minute - time.Second).Format(amzDateFormat)
		}},
		{"future date", func(a *awsAttestation) {
			a.Headers["X-Amz-Date"] = now.Add(5*time.Minute + time.Second).Format(amzDateFormat)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := attestationAt(now)
			tc.change(&a)
			if _, reason := checkAwsAttestation(a, enrollmentAudience, now); reason == "" {
				t.Fatal("accepted invalid attestation")
			}
		})
	}
	a := attestationAt(now.Add(5 * time.Minute))
	req, reason := checkAwsAttestation(a, enrollmentAudience, now)
	if reason != "" || req.url != a.URL || len(req.headers) != 6 || req.headers["host"] != a.Headers["Host"] ||
		req.signature != fmt.Sprintf("%x", sha256.Sum256([]byte(a.Headers["Authorization"]))) {
		t.Fatalf("unexpected STS forwarding: %+v %s", req, reason)
	}
}

func enrollmentServer(t *testing.T, now func() time.Time) (EnrollmentServer, *fakeHostIssuer) {
	t.Helper()
	roles, err := ParseEnrollmentRoles("build=arn:aws:iam::123456789012:role/path/host", []string{"build", "test"})
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeHostIssuer{hostTestCA: newHostTestCA(t)}
	credentials, err := IssueHostTLS(t.Context(), fake)
	if err != nil {
		t.Fatal(err)
	}
	return EnrollmentServer{Audience: enrollmentAudience, Roles: roles, Now: now,
		Certificates: HostCertificates{fake, credentials},
		STS:          stsIdentity(enrollmentARN),
		Record:       func(context.Context, string, string) error { return nil },
	}, fake
}

func stsIdentity(arn string) STS {
	return fakeSTS(func(_ context.Context, _ string, _ map[string]string, _ string) (int, []byte, error) {
		return 200, []byte("<Arn>" + arn + "</Arn>"), nil
	})
}

func postEnrollment(t *testing.T, s EnrollmentServer, a awsAttestation, csr, pool string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", enrollPath, bytes.NewReader(hostJSON(t, map[string]any{"attestation": a, "csr": csr, "pool": pool})))
	r.Header.Set("X-Amzn-Mtls-Clientcert-Leaf", "untrusted")
	s.ServeHTTP(w, r)
	return w
}

func hostJSON(t *testing.T, q any) []byte {
	t.Helper()
	raw, err := json.Marshal(q)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestUnitEnrollment(t *testing.T) {
	now := time.Now()
	server, fake := enrollmentServer(t, func() time.Time { return now })
	valid, _ := enrollCSR(t, hostSANPrefix+enrollmentHost, nil, false)
	for _, tc := range []struct {
		name, arn, pool, uri string
		dns                  []string
		badSig               bool
		want                 int
	}{
		{"role", strings.Replace(enrollmentARN, "/host/", "/other/", 1), "build", enrollmentHost, nil, false, 403},
		{"session", strings.Replace(enrollmentARN, enrollmentHost, "human", 1), "build", enrollmentHost, nil, false, 403},
		{"pool", enrollmentARN, "test", enrollmentHost, nil, false, 403},
		{"unknown pool", enrollmentARN, "other", enrollmentHost, nil, false, 400},
		{"DNS SAN", enrollmentARN, "build", enrollmentHost, []string{"host.example"}, false, 400},
		{"other URI", enrollmentARN, "build", "i-00000000", nil, false, 400},
		{"bad signature", enrollmentARN, "build", enrollmentHost, nil, true, 400},
		{"body limit", enrollmentARN, "build", enrollmentHost, nil, false, 400},
		{"enrolled", enrollmentARN, "build", enrollmentHost, nil, false, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := server
			s.STS = stsIdentity(tc.arn)
			csr, _ := enrollCSR(t, hostSANPrefix+tc.uri, tc.dns, tc.badSig)
			if tc.name == "body limit" {
				csr = valid + strings.Repeat(" ", maxEnrollmentBody)
			}
			w := postEnrollment(t, s, attestationAt(now), csr, tc.pool)
			if w.Code != tc.want {
				t.Fatalf("got %d, want %d: %s", w.Code, tc.want, w.Body)
			}
			if tc.want == 200 {
				var reply hostwire.Enrolled
				if err := json.NewDecoder(w.Body).Decode(&reply); err != nil {
					t.Fatal(err)
				}
				leaf := parseHostLeaf(t, reply.CertificatePEM)
				if err := hostcert.CheckLeaf(leaf, hostSANPrefix+enrollmentHost); err != nil {
					t.Fatal(err)
				}
				if leaf.Subject.CommonName != "different-name" || reply.HostID != enrollmentHost ||
					reply.NotAfter != leaf.NotAfter.UnixMilli() || reply.CAPEM == "" || fake.issued.Load() != 2 {
					t.Fatalf("unexpected reply identity or validity: host %s, expiry %d", reply.HostID, reply.NotAfter)
				}
			}
		})
	}
	s := server
	s.STS = fakeSTS(func(context.Context, string, map[string]string, string) (int, []byte, error) {
		return 403, []byte("<Arn>" + enrollmentARN + "</Arn>"), nil
	})
	if w := postEnrollment(t, s, attestationAt(now), valid, "build"); w.Code != 401 {
		t.Fatalf("STS refusal: %d", w.Code)
	}
}

func TestUnitEnrollmentReplay(t *testing.T) {
	now := time.Now()
	s, fake := enrollmentServer(t, func() time.Time { return now })
	seen := map[string]bool{}
	s.Record = func(_ context.Context, pool, signature string) error {
		key := pool + "/" + signature
		if seen[key] {
			return compute.ErrCondition
		}
		seen[key] = true
		return nil
	}
	a := attestationAt(now)
	csr, _ := enrollCSR(t, hostSANPrefix+enrollmentHost, nil, false)
	for _, want := range []int{200, 409} {
		if w := postEnrollment(t, s, a, csr, "build"); w.Code != want {
			t.Fatalf("got %d, want %d: %s", w.Code, want, w.Body)
		}
	}
	if fake.issued.Load() != 2 || len(seen) != 1 {
		t.Fatal("replay reached the issuer")
	}
}

func parseHostLeaf(t *testing.T, cert string) *x509.Certificate {
	t.Helper()
	block, _ := pem.Decode([]byte(cert))
	if block == nil {
		t.Fatal("missing PEM certificate")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return leaf
}

func TestUnitEnrollmentRouteIsolation(t *testing.T) {
	host := NewHostServer(&compute.Controller{Objects: store.Local{}}, nil, time.Minute)
	storage := NewStorageServer(nil, "test", nil)
	for _, handler := range []http.Handler{host, storage} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("POST", enrollPath, nil))
		if w.Code != 404 {
			t.Fatalf("%T exposed enrollment: %d", handler, w.Code)
		}
	}
	enroll := EnrollmentServer{}
	for _, path := range []string{"/", "/healthz", "/v1/hosts/a/renew", "/v1/hosts/a/register", enrollPath + "/", "/v1//hosts/enroll", "/v1/hosts/%65nroll"} {
		w := httptest.NewRecorder()
		enroll.ServeHTTP(w, httptest.NewRequest("POST", path, nil))
		if w.Code != 404 {
			t.Errorf("enrollment listener POST %s: %d", path, w.Code)
		}
	}
	for _, method := range []string{"GET", "HEAD", "PUT", "OPTIONS", "DELETE"} {
		w := httptest.NewRecorder()
		enroll.ServeHTTP(w, httptest.NewRequest(method, enrollPath, nil))
		if w.Code != 404 {
			t.Errorf("enrollment listener %s: %d", method, w.Code)
		}
	}
}

func fakeIssuedHost(t *testing.T, issuer hostcert.Issuer, host string) (tls.Certificate, string) {
	t.Helper()
	uri := hostSANPrefix + host
	csr, key := enrollCSR(t, uri, nil, false)
	der, err := hostcert.DecodeCSR(csr, uri)
	if err != nil {
		t.Fatal(err)
	}
	cert, chain, _, err := issuer.Issue(t.Context(), der, uri, hostcert.Lifetime, true)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair([]byte(cert+"\n"+chain), key)
	if err != nil {
		t.Fatal(err)
	}
	return pair, csr
}

func tierTestClient(t *testing.T, ca *x509.CertPool, host tls.Certificate) *http.Client {
	t.Helper()
	client := testHostClient(t, ca, host)
	cfg := client.Transport.(*http.Transport).TLSClientConfig
	cfg.InsecureSkipVerify = true // Verify the CA and SPIFFE URI explicitly.
	cfg.VerifyConnection = func(cs tls.ConnectionState) error {
		leaf := cs.PeerCertificates[0]
		if err := hostcert.CheckLeaf(leaf, hostcert.TierURI); err != nil {
			return err
		}
		_, err := leaf.Verify(x509.VerifyOptions{Roots: ca})
		return err
	}
	return client
}

func TestUnitHostRenewal(t *testing.T) {
	enroll, issuer := enrollmentServer(t, nil)
	server := NewHostServer(&compute.Controller{Objects: store.Local{}}, nil, time.Minute)
	server.EnableRenewal(enroll.Certificates)
	tier := testTier(t, enroll.Certificates.TLS, server)
	host, _ := fakeIssuedHost(t, issuer, enrollmentHost)
	client := tierTestClient(t, issuer.pool, host)
	csr, key := enrollCSR(t, hostSANPrefix+enrollmentHost, nil, false)
	post := func(id, csr string, want int) hostwire.Enrolled {
		t.Helper()
		resp, err := client.Post(tier.URL+"/v1/hosts/"+id+"/renew", "application/json",
			bytes.NewReader(hostJSON(t, hostwire.Renew{CSR: csr})))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != want {
			t.Fatalf("renew: got %d, want %d", resp.StatusCode, want)
		}
		var result hostwire.Enrolled
		if want == 200 {
			if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}
		}
		return result
	}
	post("i-1123456789abcdef0", csr, 403)
	otherCSR, _ := enrollCSR(t, hostSANPrefix+"i-1123456789abcdef0", nil, false)
	post(enrollmentHost, otherCSR, 400)
	reply := post(enrollmentHost, csr, 200)
	renewed, err := tls.X509KeyPair([]byte(reply.CertificatePEM+"\n"+reply.ChainPEM), key)
	if err != nil || reply.HostID != enrollmentHost || bytes.Equal(renewed.Certificate[0], host.Certificate[0]) {
		t.Fatalf("unexpected renewal result for %s: %v", reply.HostID, err)
	}
	client = tierTestClient(t, issuer.pool, renewed)
	post(enrollmentHost, csr, 200)
}

func TestUnitTierCertificateRotation(t *testing.T) {
	enroll, issuer := enrollmentServer(t, nil)
	credentials := enroll.Certificates.TLS
	host, _ := fakeIssuedHost(t, issuer, enrollmentHost)
	tier := testTier(t, credentials, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(204)
	}))
	client := tierTestClient(t, issuer.pool, host)
	seenTier := func() *big.Int {
		t.Helper()
		resp, err := client.Get(tier.URL)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return resp.TLS.PeerCertificates[0].SerialNumber
	}
	initial := seenTier()
	if initial.Cmp(credentials.current.Load().Certificates[0].Leaf.SerialNumber) != 0 {
		t.Fatal("listener did not present bootstrapped certificate")
	}

	now := time.Now()
	nextRenew, nextRefresh := now, now
	issuer.fail = true
	other := newHostTestCA(t)
	issuer.bundle = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: other.cert.Raw}))
	credentials.rotateAt(t.Context(), issuer, now, &nextRenew, &nextRefresh)
	if seenTier().Cmp(initial) != 0 || !nextRenew.Equal(now) || !nextRefresh.Equal(now.Add(time.Hour)) ||
		!strings.Contains(credentials.current.Load().caPEM, issuer.bundle) {
		t.Fatal("failed renewal must retain the old certificate, and CA refresh must continue")
	}

	issuer.fail = false
	now = now.Add(time.Minute)
	credentials.rotateAt(t.Context(), issuer, now, &nextRenew, &nextRefresh)
	rotated := seenTier()
	if rotated.Cmp(initial) == 0 || !nextRenew.Equal(now.Add(8*time.Hour)) {
		t.Fatal("listener did not rotate its leaf")
	}

	received := make(chan *big.Int, 1)
	hostServer := fakeHostTLS(t, issuer.hostTestCA, host, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.TLS.PeerCertificates[0].SerialNumber
		w.WriteHeader(204)
	}))
	addr := strings.TrimPrefix(hostServer.URL, "https://")
	pusher := HostPusher{TLS: credentials}
	if err := pusher.Stop(t.Context(), compute.Host{HostInfo: compute.HostInfo{Addr: addr, Host: enrollmentHost}}, "vm", false); err != nil {
		t.Fatal(err)
	}
	if (<-received).Cmp(rotated) != 0 {
		t.Fatal("push did not present rotated leaf")
	}

	otherHost := other.leaf(t, x509.ExtKeyUsageClientAuth, hostSANPrefix+enrollmentHost)
	otherClient := tierTestClient(t, issuer.pool, otherHost)
	resp, err := otherClient.Get(tier.URL)
	if err != nil {
		t.Fatal("listener did not trust added CA:", err)
	}
	resp.Body.Close()

	issuer.bundle = ""
	credentials.rotateAt(t.Context(), issuer, nextRefresh, &nextRenew, &nextRefresh)
	resp, err = otherClient.Get(tier.URL)
	if err == nil {
		resp.Body.Close()
		t.Fatal("listener still trusts removed CA")
	}
}
