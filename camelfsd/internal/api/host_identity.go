package api

import (
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"slices"

	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
)

const hostSANPrefix = "spiffe://camelfs/host/"

var errHostCertificateMissing = errors.New("missing host certificate")
var errHostForbidden = errors.New("host identity does not match")

func hostIdentity(r *http.Request) (string, error) {
	if r.TLS == nil || len(r.TLS.VerifiedChains) == 0 || len(r.TLS.VerifiedChains[0]) == 0 {
		return "", errHostForbidden
	}
	leaf := r.TLS.VerifiedChains[0][0]
	id := r.PathValue("host")
	if !slices.Contains(leaf.ExtKeyUsage, x509.ExtKeyUsageClientAuth) || !matchesHostSAN(leaf, id) {
		return "", errHostForbidden
	}
	return id, nil
}

func matchesHostSAN(leaf *x509.Certificate, id string) bool {
	return hostwire.HostID.MatchString(id) && len(leaf.URIs) == 1 && leaf.URIs[0].String() == hostSANPrefix+id
}

func verifyHostCertificate(leaf *x509.Certificate, intermediates, ca *x509.CertPool, usage x509.ExtKeyUsage, id string) error {
	if ca == nil || !matchesHostSAN(leaf, id) {
		return errHostForbidden
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: ca, Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{usage}}); err != nil {
		return fmt.Errorf("host certificate chain: %w", err)
	}
	return nil
}
