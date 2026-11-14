package hostcert

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/acmpca"
	"github.com/aws/aws-sdk-go-v2/service/acmpca/types"
)

const endEntityTemplate = "arn:aws:acm-pca:::template/EndEntityCertificate/V1"

type PCAClient interface {
	DescribeCertificateAuthority(context.Context, *acmpca.DescribeCertificateAuthorityInput, ...func(*acmpca.Options)) (*acmpca.DescribeCertificateAuthorityOutput, error)
	IssueCertificate(context.Context, *acmpca.IssueCertificateInput, ...func(*acmpca.Options)) (*acmpca.IssueCertificateOutput, error)
	GetCertificate(context.Context, *acmpca.GetCertificateInput, ...func(*acmpca.Options)) (*acmpca.GetCertificateOutput, error)
	GetCertificateAuthorityCertificate(context.Context, *acmpca.GetCertificateAuthorityCertificateInput, ...func(*acmpca.Options)) (*acmpca.GetCertificateAuthorityCertificateOutput, error)
}

type PCA struct {
	client    PCAClient
	arn       string
	algorithm types.SigningAlgorithm
}

func NewPCA(ctx context.Context, client PCAClient, arn string) (*PCA, error) {
	out, err := client.DescribeCertificateAuthority(ctx, &acmpca.DescribeCertificateAuthorityInput{CertificateAuthorityArn: aws.String(arn)})
	if err != nil {
		return nil, fmt.Errorf("describe hosts CA: %w", err)
	}
	if out.CertificateAuthority == nil || out.CertificateAuthority.CertificateAuthorityConfiguration == nil {
		return nil, errors.New("missing hosts CA configuration")
	}
	var algorithm types.SigningAlgorithm
	switch out.CertificateAuthority.CertificateAuthorityConfiguration.KeyAlgorithm {
	case types.KeyAlgorithmRsa2048, types.KeyAlgorithmRsa3072, types.KeyAlgorithmRsa4096:
		algorithm = types.SigningAlgorithmSha256withrsa
	case types.KeyAlgorithmEcPrime256v1:
		algorithm = types.SigningAlgorithmSha256withecdsa
	case types.KeyAlgorithmEcSecp384r1:
		algorithm = types.SigningAlgorithmSha384withecdsa
	case types.KeyAlgorithmEcSecp521r1:
		algorithm = types.SigningAlgorithmSha512withecdsa
	default:
		return nil, errors.New("unsupported hosts CA key algorithm")
	}
	return &PCA{client, arn, algorithm}, nil
}

func (p *PCA) Issue(ctx context.Context, csrDER []byte, sanURI string, validity time.Duration, serverAndClient bool) (string, string, time.Time, error) {
	if err := CheckCSR(csrDER, sanURI); err != nil {
		return "", "", time.Time{}, fmt.Errorf("issue certificate: %w", err)
	}
	if validity != Lifetime || !serverAndClient {
		return "", "", time.Time{}, errors.New("hosts CA issues 24-hour server and client certificates")
	}
	hash := sha256.New()
	hash.Write(csrDER)
	hash.Write([]byte(sanURI))
	token := fmt.Sprintf("%x", hash.Sum(nil)[:18])
	out, err := p.client.IssueCertificate(ctx, &acmpca.IssueCertificateInput{
		CertificateAuthorityArn: aws.String(p.arn),
		Csr:                     pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER}),
		TemplateArn:             aws.String(endEntityTemplate),
		SigningAlgorithm:        p.algorithm,
		// Private CA expresses a 24-hour relative validity as one day.
		Validity:         &types.Validity{Type: types.ValidityPeriodTypeDays, Value: aws.Int64(1)},
		IdempotencyToken: aws.String(token),
	})
	if err != nil {
		return "", "", time.Time{}, fmt.Errorf("issue certificate: %w", err)
	}
	if aws.ToString(out.CertificateArn) == "" {
		return "", "", time.Time{}, errors.New("missing issued certificate ARN")
	}
	result, err := p.getCertificate(ctx, out.CertificateArn)
	if err != nil {
		return "", "", time.Time{}, err
	}
	cert := aws.ToString(result.Certificate)
	block, _ := pem.Decode([]byte(cert))
	if block == nil || block.Type != "CERTIFICATE" {
		return "", "", time.Time{}, errors.New("Private CA returned an invalid leaf PEM")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", "", time.Time{}, fmt.Errorf("parse Private CA leaf: %w", err)
	}
	if err := CheckLeaf(leaf, sanURI); err != nil {
		return "", "", time.Time{}, fmt.Errorf("invalid Private CA leaf: %w", err)
	}
	return cert, aws.ToString(result.CertificateChain), leaf.NotAfter, nil
}

func (p *PCA) getCertificate(ctx context.Context, arn *string) (*acmpca.GetCertificateOutput, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	input := &acmpca.GetCertificateInput{CertificateAuthorityArn: aws.String(p.arn), CertificateArn: arn}
	for delay := 100 * time.Millisecond; ; delay = min(2*delay, time.Second) {
		out, err := p.client.GetCertificate(ctx, input, func(o *acmpca.Options) { o.Retryer = aws.NopRetryer{} })
		var pending *types.RequestInProgressException
		if !errors.As(err, &pending) {
			return out, err
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, fmt.Errorf("wait for issued certificate: %w", ctx.Err())
		case <-timer.C:
		}
	}
}

func (p *PCA) CACertificate(ctx context.Context) (string, error) {
	out, err := p.client.GetCertificateAuthorityCertificate(ctx, &acmpca.GetCertificateAuthorityCertificateInput{CertificateAuthorityArn: aws.String(p.arn)})
	if err != nil {
		return "", err
	}
	if aws.ToString(out.Certificate) == "" {
		return "", errors.New("missing hosts CA certificate")
	}
	return strings.TrimSpace(aws.ToString(out.Certificate)+"\n"+aws.ToString(out.CertificateChain)) + "\n", nil
}
