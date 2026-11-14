package hostcert

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/acmpca"
	"github.com/aws/aws-sdk-go-v2/service/acmpca/types"
)

const testCAARN = "arn:aws:acm-pca:us-west-2:123456789012:certificate-authority/test"

type fakePCA struct {
	issued          *acmpca.IssueCertificateInput
	describe, polls int
	leaf, ca        string
}

func (f *fakePCA) DescribeCertificateAuthority(_ context.Context, in *acmpca.DescribeCertificateAuthorityInput, _ ...func(*acmpca.Options)) (*acmpca.DescribeCertificateAuthorityOutput, error) {
	f.describe++
	if aws.ToString(in.CertificateAuthorityArn) != testCAARN {
		return nil, fmt.Errorf("unexpected CA ARN")
	}
	return &acmpca.DescribeCertificateAuthorityOutput{CertificateAuthority: &types.CertificateAuthority{
		CertificateAuthorityConfiguration: &types.CertificateAuthorityConfiguration{KeyAlgorithm: types.KeyAlgorithmEcSecp384r1},
	}}, nil
}

func (f *fakePCA) IssueCertificate(_ context.Context, in *acmpca.IssueCertificateInput, _ ...func(*acmpca.Options)) (*acmpca.IssueCertificateOutput, error) {
	f.issued = in
	f.polls = 0
	return &acmpca.IssueCertificateOutput{CertificateArn: aws.String(testCAARN + "/certificate/test")}, nil
}

func (f *fakePCA) GetCertificate(ctx context.Context, in *acmpca.GetCertificateInput, _ ...func(*acmpca.Options)) (*acmpca.GetCertificateOutput, error) {
	f.polls++
	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 10*time.Second {
		return nil, fmt.Errorf("missing ten-second polling deadline")
	}
	if aws.ToString(in.CertificateAuthorityArn) != testCAARN || aws.ToString(in.CertificateArn) != testCAARN+"/certificate/test" {
		return nil, fmt.Errorf("unexpected polling ARN")
	}
	if f.polls == 1 {
		return nil, &types.RequestInProgressException{}
	}
	return &acmpca.GetCertificateOutput{Certificate: aws.String(f.leaf), CertificateChain: aws.String(f.ca)}, nil
}

func (f *fakePCA) GetCertificateAuthorityCertificate(_ context.Context, in *acmpca.GetCertificateAuthorityCertificateInput, _ ...func(*acmpca.Options)) (*acmpca.GetCertificateAuthorityCertificateOutput, error) {
	if aws.ToString(in.CertificateAuthorityArn) != testCAARN {
		return nil, fmt.Errorf("unexpected CA ARN")
	}
	return &acmpca.GetCertificateAuthorityCertificateOutput{Certificate: aws.String(f.ca)}, nil
}

func TestUnitPCAIssue(t *testing.T) {
	const uri = "spiffe://camelfs/host/i-12345678"
	san, _ := url.Parse(uri)
	other, _ := url.Parse("spiffe://camelfs/host/i-87654321")
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{URIs: []*url.URL{san}}, key)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Truncate(time.Second)
	expires := now.Add(Lifetime)
	encode := func(template, parent *x509.Certificate) string {
		t.Helper()
		raw, err := x509.CreateCertificate(rand.Reader, template, parent, &key.PublicKey, key)
		if err != nil {
			t.Fatal(err)
		}
		return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw}))
	}
	root := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: now, NotAfter: expires.Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), NotBefore: now, NotAfter: expires, URIs: []*url.URL{san},
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth}}
	fake := &fakePCA{leaf: encode(leaf, root), ca: encode(root, root)}
	pca, err := NewPCA(t.Context(), fake, testCAARN)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := pca.Issue(t.Context(), der, other.String(), Lifetime, true); err == nil || fake.issued != nil {
		t.Fatal("CA called with a mismatched CSR SAN")
	}
	cert, chain, notAfter, err := pca.Issue(t.Context(), der, uri, Lifetime, true)
	if err != nil || cert != fake.leaf || chain != fake.ca || !notAfter.Equal(expires) || fake.describe != 1 || fake.polls != 2 {
		t.Fatalf("unexpected certificate result: expiry %v, describes %d, polls %d, error %v", notAfter, fake.describe, fake.polls, err)
	}
	in := fake.issued
	token := fmt.Sprintf("%x", sha256.Sum256(append(bytes.Clone(der), uri...)))[:36]
	csr, rest := pem.Decode(in.Csr)
	if aws.ToString(in.CertificateAuthorityArn) != testCAARN ||
		aws.ToString(in.TemplateArn) != "arn:aws:acm-pca:::template/EndEntityCertificate/V1" ||
		in.SigningAlgorithm != types.SigningAlgorithmSha384withecdsa ||
		in.Validity.Type != types.ValidityPeriodTypeDays || aws.ToInt64(in.Validity.Value) != 1 ||
		aws.ToString(in.IdempotencyToken) != token || in.ApiPassthrough != nil ||
		csr == nil || csr.Type != "CERTIFICATE REQUEST" || len(rest) != 0 || !bytes.Equal(csr.Bytes, der) {
		t.Fatal("incorrect IssueCertificate fields")
	}
	if bundle, err := pca.CACertificate(t.Context()); err != nil || bundle != fake.ca {
		t.Fatalf("CA retrieval: %v", err)
	}
	leaf.URIs = []*url.URL{other}
	fake.leaf = encode(leaf, root)
	if _, _, _, err := pca.Issue(t.Context(), der, uri, Lifetime, true); err == nil || !strings.Contains(err.Error(), "SAN") {
		t.Fatalf("CA leaf with wrong SAN: %v", err)
	}
	leaf.URIs = []*url.URL{san}
	leaf.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	fake.leaf = encode(leaf, root)
	if _, _, _, err := pca.Issue(t.Context(), der, uri, Lifetime, true); err == nil || !strings.Contains(err.Error(), "EKU") {
		t.Fatalf("CA leaf with wrong EKU: %v", err)
	}
}
