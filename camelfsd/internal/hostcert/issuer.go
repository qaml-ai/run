// Package hostcert validates and issues the certificates used by the host channel.
package hostcert

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/pem"
	"errors"
	"slices"
	"time"
)

const Lifetime = 24 * time.Hour
const TierURI = "spiffe://camelfs/tier"

type Issuer interface {
	Issue(ctx context.Context, csrDER []byte, sanURI string, validity time.Duration, serverAndClient bool) (certPEM, chainPEM string, notAfter time.Time, err error)
	CACertificate(ctx context.Context) (caPEM string, err error)
}

func DecodeCSR(raw, uri string) ([]byte, error) {
	data := bytes.TrimSpace([]byte(raw))
	block, rest := pem.Decode(data)
	if !bytes.HasPrefix(data, []byte("-----BEGIN CERTIFICATE REQUEST-----")) || block == nil || block.Type != "CERTIFICATE REQUEST" || len(block.Headers) != 0 || len(bytes.TrimSpace(rest)) != 0 ||
		bytes.Count(data, []byte("-----BEGIN ")) != 1 {
		return nil, errors.New("expected one PEM certificate request")
	}
	if err := CheckCSR(block.Bytes, uri); err != nil {
		return nil, err
	}
	return block.Bytes, nil
}

func CheckCSR(der []byte, uri string) error {
	csr, err := x509.ParseCertificateRequest(der)
	if err != nil {
		return err
	}
	if err := csr.CheckSignature(); err != nil {
		return err
	}
	switch key := csr.PublicKey.(type) {
	case *ecdsa.PublicKey:
		if key.Curve != elliptic.P256() && key.Curve != elliptic.P384() {
			return errors.New("unsupported ECDSA curve")
		}
	case *rsa.PublicKey:
		if key.N.BitLen() < 2048 {
			return errors.New("RSA key too small")
		}
	default:
		return errors.New("unsupported key type")
	}
	// ParseCertificateRequest uses only the first value of an extensionRequest
	// attribute. Reject ambiguous requests before handing the original CSR to PCA.
	var info struct {
		Version    int
		Subject    asn1.RawValue
		PublicKey  asn1.RawValue
		Attributes []struct {
			ID     asn1.ObjectIdentifier
			Values []asn1.RawValue `asn1:"set"`
		} `asn1:"tag:0"`
	}
	if rest, err := asn1.Unmarshal(csr.RawTBSCertificateRequest, &info); err != nil || len(rest) != 0 {
		return errors.New("invalid CSR attributes")
	}
	var requests int
	for _, attr := range info.Attributes {
		if attr.ID.Equal(extensionRequestOID) {
			requests++
			if len(attr.Values) != 1 {
				return errors.New("ambiguous CSR extensions")
			}
		}
	}
	if requests != 1 || len(csr.Extensions) != 1 {
		return errors.New("CSR must request only the SAN extension")
	}
	return checkSAN(csr.Extensions, uri)
}

var extensionRequestOID = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 9, 14}
var sanOID = asn1.ObjectIdentifier{2, 5, 29, 17}

func checkSAN(extensions []pkix.Extension, uri string) error {
	// Go's parsed SAN fields omit GeneralName types it doesn't interpret.
	// Compare the entire DER sequence to exactly one URI GeneralName.
	expected, err := asn1.Marshal([]asn1.RawValue{{Class: asn1.ClassContextSpecific, Tag: 6, Bytes: []byte(uri)}})
	if err != nil {
		return err
	}
	found := false
	for _, ext := range extensions {
		if ext.Id.Equal(sanOID) {
			if found || !bytes.Equal(ext.Value, expected) {
				return errors.New("SAN must contain exactly the expected URI")
			}
			found = true
		}
	}
	if !found {
		return errors.New("missing URI SAN")
	}
	return nil
}

func CheckLeaf(leaf *x509.Certificate, uri string) error {
	if err := checkSAN(leaf.Extensions, uri); err != nil {
		return err
	}
	if leaf.IsCA || len(leaf.ExtKeyUsage) != 2 || len(leaf.UnknownExtKeyUsage) != 0 ||
		!slices.Contains(leaf.ExtKeyUsage, x509.ExtKeyUsageServerAuth) ||
		!slices.Contains(leaf.ExtKeyUsage, x509.ExtKeyUsageClientAuth) {
		return errors.New("certificate requires serverAuth and clientAuth EKUs")
	}
	return nil
}
