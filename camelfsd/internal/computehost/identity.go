package computehost

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/ec2/imds"
	"github.com/qaml-ai/run/camelfsd/internal/hostcert"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type attestation struct {
	Kind    string            `json:"kind"`
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

func AWSIdentity(ctx context.Context, region, audience string) (string, func(context.Context) (attestation, error), error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return "", nil, err
	}
	instance, err := imds.NewFromConfig(cfg).GetInstanceIdentityDocument(ctx, nil)
	if err != nil {
		return "", nil, err
	}
	return instance.InstanceID, func(ctx context.Context) (attestation, error) {
		const body = "Action=GetCallerIdentity&Version=2011-06-15"
		endpoint := "https://sts." + instance.Region + ".amazonaws.com/"
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewBufferString(body))
		if err != nil {
			return attestation{}, err
		}
		// STS replay reconstructs the body. Sign only headers retained by the
		// enrollment endpoint, leaving Content-Length to its HTTP transport.
		req.ContentLength = 0
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")
		req.Header.Set("x-camelrun-job-host-audience", audience)
		creds, err := cfg.Credentials.Retrieve(ctx)
		if err != nil {
			return attestation{}, err
		}
		if err := v4.NewSigner().SignHTTP(ctx, creds, req, fmt.Sprintf("%x", sha256.Sum256([]byte(body))), "sts", instance.Region, time.Now()); err != nil {
			return attestation{}, err
		}
		headers := map[string]string{"host": req.URL.Host}
		for name := range req.Header {
			headers[name] = req.Header.Get(name)
		}
		return attestation{"aws", http.MethodPost, endpoint, headers, body}, nil
	}, nil
}

type credentials struct {
	server  *tls.Config
	renewAt time.Time
}

type Identity struct {
	HostID                         string
	dir, endpoint, enrollURL, pool string
	key                            *ecdsa.PrivateKey
	keyPEM                         []byte
	attest                         func(context.Context) (attestation, error)
	enrollment                     *http.Client
	current                        atomic.Pointer[credentials]
}

func NewIdentity(ctx context.Context, dir, id, pool, endpoint, enrollURL string, attest func(context.Context) (attestation, error)) (*Identity, error) {
	return newIdentity(ctx, dir, id, pool, endpoint, enrollURL, attest, &http.Client{CheckRedirect: noRedirect})
}

func newIdentity(ctx context.Context, dir, id, pool, endpoint, enrollURL string, attest func(context.Context) (attestation, error), enrollment *http.Client) (*Identity, error) {
	u, err := url.Parse(enrollURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" && u.Path != "/v1/hosts/enroll" || !hostwire.HostID.MatchString(id) {
		return nil, errors.New("invalid enroll URL or host ID")
	}
	u.Path = "/v1/hosts/enroll"
	raw, err := loadKey(dir)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, errors.New("invalid host key PEM")
	}
	key, err := x509.ParseECPrivateKey(block.Bytes)
	if err != nil || key.Curve != elliptic.P256() {
		return nil, errors.New("invalid host P-256 key")
	}
	i := &Identity{HostID: id, dir: dir, endpoint: endpoint, enrollURL: u.String(), pool: pool, key: key, keyPEM: raw, attest: attest, enrollment: enrollment}
	saved, err := os.ReadFile(filepath.Join(dir, "host-certificate.json"))
	if err == nil {
		var reply hostwire.Enrolled
		if err = json.Unmarshal(saved, &reply); err != nil {
			return nil, err
		}
		if err := i.install(reply, false); err != nil {
			if !errors.Is(err, errExpired) {
				return nil, err
			}
		} else {
			return i, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := i.issue(ctx, true); err != nil {
		return nil, err
	}
	return i, nil
}

func loadKey(dir string) ([]byte, error) {
	path := filepath.Join(dir, "host-key.pem")
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
			return nil, errors.New("host key must be a 0600 regular file")
		}
		return os.ReadFile(path)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	raw := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})
	return raw, store.Atomic(path, raw)
}

var errExpired = errors.New("host certificate expired")

const hostURI = "spiffe://camelfs/host/"

func (i *Identity) install(reply hostwire.Enrolled, save bool) error {
	if reply.HostID != i.HostID {
		return errors.New("enrollment returned a different host ID")
	}
	pair, err := tls.X509KeyPair([]byte(reply.CertificatePEM+"\n"+reply.ChainPEM), i.keyPEM)
	if err != nil {
		return err
	}
	if err := hostcert.CheckLeaf(pair.Leaf, hostURI+i.HostID); err != nil {
		return err
	}
	if !time.Now().Before(pair.Leaf.NotAfter) {
		return errExpired
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(reply.CAPEM)) {
		return errors.New("invalid host CA bundle")
	}
	for _, usage := range []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth} {
		if err := verifyPeer(pair.Leaf, pair.Certificate[1:], roots, usage); err != nil {
			return err
		}
	}
	server := &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{pair}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots, SessionTicketsDisabled: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			return hostcert.CheckLeaf(cs.VerifiedChains[0][0], hostcert.TierURI)
		}}
	if save {
		raw, err := json.Marshal(reply)
		if err != nil {
			return err
		}
		if err := store.Atomic(filepath.Join(i.dir, "host-certificate.json"), raw); err != nil {
			return err
		}
	}
	lifetime := pair.Leaf.NotAfter.Sub(pair.Leaf.NotBefore)
	i.current.Store(&credentials{server: server, renewAt: pair.Leaf.NotBefore.Add(min(8*time.Hour, lifetime*2/3))})
	return nil
}

func verifyPeer(leaf *x509.Certificate, chain [][]byte, roots *x509.CertPool, usage x509.ExtKeyUsage) error {
	pool := x509.NewCertPool()
	for _, raw := range chain {
		cert, err := x509.ParseCertificate(raw)
		if err != nil {
			return err
		}
		pool.AddCert(cert)
	}
	_, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: pool, KeyUsages: []x509.ExtKeyUsage{usage}})
	return err
}

func (i *Identity) issue(ctx context.Context, enroll bool) error {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	uri, _ := url.Parse(hostURI + i.HostID)
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{URIs: []*url.URL{uri}}, i.key)
	if err != nil {
		return err
	}
	csr := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}))
	var reply hostwire.Enrolled
	if enroll {
		if i.attest == nil {
			return errors.New("host enrollment attestor unavailable")
		}
		a, err := i.attest(ctx)
		if err != nil {
			return err
		}
		body := struct {
			Attestation attestation `json:"attestation"`
			CSR         string      `json:"csr"`
			Pool        string      `json:"pool"`
		}{a, csr, i.pool}
		err = post(ctx, i.enrollment, i.enrollURL, body, &reply)
		if err != nil {
			return err
		}
	} else if err = i.Post(ctx, "/renew", hostwire.Renew{CSR: csr}, &reply); err != nil {
		return err
	}
	return i.install(reply, true)
}

func (i *Identity) ServerTLS() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) { return i.current.Load().server, nil }}
}

func (i *Identity) Post(ctx context.Context, path string, body, out any) error {
	state := i.current.Load().server
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, Certificates: state.Certificates, InsecureSkipVerify: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			leaf := cs.PeerCertificates[0]
			if err := hostcert.CheckLeaf(leaf, hostcert.TierURI); err != nil {
				return err
			}
			pool := x509.NewCertPool()
			for _, cert := range cs.PeerCertificates[1:] {
				pool.AddCert(cert)
			}
			_, err := leaf.Verify(x509.VerifyOptions{Roots: state.ClientCAs, Intermediates: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
			return err
		}}
	transport := &http.Transport{TLSClientConfig: tlsConfig, DisableKeepAlives: true, DialContext: (&net.Dialer{}).DialContext}
	client := &http.Client{Transport: transport, CheckRedirect: noRedirect, Timeout: 45 * time.Second}
	return post(ctx, client, "https://"+i.endpoint+"/v1/hosts/"+url.PathEscape(i.HostID)+path, body, out)
}

func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

type tierError struct {
	Status int
	Body   json.RawMessage
	Code   string
}

func (e *tierError) Error() string { return fmt.Sprintf("tier HTTP %d %s", e.Status, e.Code) }

func post(ctx context.Context, client *http.Client, endpoint string, body, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		var envelope errorEnvelope
		_ = json.Unmarshal(raw, &envelope)
		code := envelope.Error.Code
		if code == "" {
			var legacy struct{ Error string }
			_ = json.Unmarshal(raw, &legacy)
			code = legacy.Error
		}
		return &tierError{resp.StatusCode, raw, code}
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(out)
}

func (i *Identity) Rotate(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		state := i.current.Load()
		if !time.Now().Before(state.renewAt) {
			expired := !time.Now().Before(state.server.Certificates[0].Leaf.NotAfter)
			if err := i.issue(ctx, expired); err != nil && ctx.Err() == nil {
				slog.Warn("compute_certificate_rotation_failed", "error", err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
