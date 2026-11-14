package api

import (
	"bytes"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
)

const hostSANPrefix = "spiffe://camelfs/host/"
const leafHeader = "X-Amzn-Mtls-Clientcert-Leaf"

var errHostCertificateMissing = errors.New("missing or malformed host certificate")
var errHostForbidden = errors.New("host identity does not match")

func hostIdentity(r *http.Request, ca *x509.CertPool) (string, error) {
	if len(r.Header.Values(leafHeader)) != 1 {
		return "", errHostCertificateMissing
	}
	raw, err := url.PathUnescape(r.Header.Get(leafHeader))
	if err != nil {
		return "", errHostCertificateMissing
	}
	block, rest := pem.Decode([]byte(raw))
	if block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 ||
		!strings.HasPrefix(strings.TrimSpace(raw), "-----BEGIN CERTIFICATE-----") {
		return "", errHostCertificateMissing
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", errHostCertificateMissing
	}
	id := r.PathValue("host")
	if err := verifyHostCertificate(leaf, nil, ca, x509.ExtKeyUsageClientAuth, id); err != nil {
		return "", errHostForbidden
	}
	return id, nil
}

func verifyHostCertificate(leaf *x509.Certificate, intermediates, ca *x509.CertPool, usage x509.ExtKeyUsage, id string) error {
	if ca == nil || !hostwire.HostID.MatchString(id) || len(leaf.URIs) != 1 || leaf.URIs[0].String() != hostSANPrefix+id {
		return errHostForbidden
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: ca, Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{usage}}); err != nil {
		return fmt.Errorf("host certificate chain: %w", err)
	}
	return nil
}
