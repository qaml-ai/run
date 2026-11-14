package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/hostcert"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
)

const maxEnrollmentBody = 64 << 10

type EnrollmentServer struct {
	Audience     string
	Roles        EnrollmentRoles
	STS          STS
	Record       func(context.Context, string, string) error
	Certificates HostCertificates
	Now          func() time.Time
}

func (s EnrollmentServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.EscapedPath() != "/v1/hosts/enroll" {
		http.NotFound(w, r)
		return
	}
	if refusal := s.enroll(w, r); refusal != nil {
		slog.Warn("host_enroll_refused", "reason", refusal.code)
		storageFail(w, &storageError{refusal.status, refusal.code, nil})
	}
}

func (s EnrollmentServer) enroll(w http.ResponseWriter, r *http.Request) *hostError {
	var q struct {
		Attestation awsAttestation `json:"attestation"`
		CSR         string         `json:"csr"`
		Pool        string         `json:"pool"`
	}
	if readHostBody(w, r, &q, maxEnrollmentBody) != nil ||
		(q.Pool != "build" && q.Pool != "test") || q.CSR == "" ||
		(q.Attestation.Kind != "" && q.Attestation.Kind != "aws") ||
		q.Attestation.Method == "" || q.Attestation.URL == "" || q.Attestation.Headers == nil || q.Attestation.Body == "" {
		return &hostError{400, "invalid_request"}
	}
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	request, reason := checkAwsAttestation(q.Attestation, s.Audience, now())
	if reason != "" {
		return &hostError{401, reason}
	}
	ctx := r.Context()
	status, raw, err := s.STS.Do(ctx, request.url, request.headers, stsBody)
	if err != nil || status != http.StatusOK {
		return &hostError{401, "sts_refused"}
	}
	host, pool := awsCaller(raw, s.Roles)
	if host == "" || pool != q.Pool {
		return &hostError{403, "role_or_pool_refused"}
	}
	if err := s.Record(ctx, pool, request.signature); err != nil {
		if errors.Is(err, compute.ErrCondition) {
			return &hostError{409, "replay"}
		}
		return &hostError{500, "record_failed"}
	}
	reply, err := s.Certificates.issue(ctx, host, q.CSR)
	if err != nil {
		var refusal hostError
		if errors.As(err, &refusal) {
			return &refusal
		}
		return &hostError{500, "issuer_failed"}
	}
	slog.Info("host_enrolled", "hostId", host, "pool", pool, "notAfter", reply.NotAfter)
	jsonReply(w, http.StatusOK, reply)
	return nil
}

// HostCertificates uses the tier's refreshed trust bundle in enrollment and renewal replies.
type HostCertificates struct {
	Issuer hostcert.Issuer
	TLS    *HostTLS
}

func (c HostCertificates) issue(ctx context.Context, host, csr string) (hostwire.Enrolled, error) {
	san := hostSANPrefix + host
	der, err := hostcert.DecodeCSR(csr, san)
	if err != nil {
		return hostwire.Enrolled{}, hostError{400, "invalid_csr"}
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cert, chain, expires, err := c.Issuer.Issue(ctx, der, san, hostcert.Lifetime, true)
	if err != nil {
		slog.Error("host_certificate_issue_failed", "reason", "issuer_failed")
		return hostwire.Enrolled{}, hostError{500, "issuer_failed"}
	}
	return hostwire.Enrolled{
		CertificatePEM: cert, ChainPEM: chain, CAPEM: c.TLS.current.Load().caPEM, NotAfter: expires.UnixMilli(), HostID: host,
	}, nil
}

func (c HostCertificates) renew(w http.ResponseWriter, r *http.Request, host string) error {
	var q hostwire.Renew
	if err := readHostBody(w, r, &q, maxEnrollmentBody); err != nil {
		return err
	}
	reply, err := c.issue(r.Context(), host, q.CSR)
	if err != nil {
		return err
	}
	jsonReply(w, http.StatusOK, reply)
	return nil
}

func (s *HostServer) EnableRenewal(c HostCertificates) {
	s.routes.HandleFunc("POST /v1/hosts/{host}/renew", s.authenticated(c.renew))
}
