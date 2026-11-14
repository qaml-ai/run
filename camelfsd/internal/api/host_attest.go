package api

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
)

const audienceHeader = "x-camelrun-job-host-audience"
const stsBody = "Action=GetCallerIdentity&Version=2011-06-15"
const amzDateFormat = "20060102T150405Z"

var (
	stsHost       = regexp.MustCompile(`^sts(\.[a-z]{2}(-gov)?-[a-z]+-\d)?\.amazonaws\.com$`)
	signedHeaders = regexp.MustCompile(`SignedHeaders=([a-z0-9;-]+)`)
	callerARN     = regexp.MustCompile(`<Arn>([^<]+)</Arn>`)
	assumedRole   = regexp.MustCompile(`^arn:(aws|aws-us-gov):sts::(\d{12}):assumed-role/([^/]+)/([^/]+)$`)
	allowedRole   = regexp.MustCompile(`^arn:(aws|aws-us-gov):iam::(\d{12}):role/(?:.*/)?([^/]+)$`)
	instanceID    = regexp.MustCompile(`^i-[0-9a-f]{8,17}$`)
)

type awsAttestation struct {
	Kind    string            `json:"kind,omitempty"`
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

type stsRequest struct {
	url, signature string
	headers        map[string]string
}

func checkAwsAttestation(a awsAttestation, audience string, now time.Time) (stsRequest, string) {
	u, err := url.Parse(a.URL)
	if err != nil || a.Method != http.MethodPost || u.Scheme != "https" || u.User != nil ||
		!stsHost.MatchString(strings.ToLower(u.Hostname())) || (u.Port() != "" && u.Port() != "443") ||
		(u.EscapedPath() != "" && u.EscapedPath() != "/") || u.RawQuery != "" {
		return stsRequest{}, "invalid_sts_request"
	}
	if a.Body != stsBody {
		return stsRequest{}, "invalid_sts_body"
	}
	host := strings.ToLower(u.Hostname())
	headers := make(map[string]string, len(a.Headers))
	for name, value := range a.Headers {
		name = strings.ToLower(name)
		if _, exists := headers[name]; exists {
			return stsRequest{}, "duplicate_sts_header"
		}
		headers[name] = value
	}
	if headers["host"] != host {
		return stsRequest{}, "signed_host_mismatch"
	}
	if headers[audienceHeader] != audience {
		return stsRequest{}, "audience_mismatch"
	}
	auth := headers["authorization"]
	signed := signedHeaders.FindStringSubmatch(auth)
	if !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 ") || signed == nil {
		return stsRequest{}, "unsigned_sts_header"
	}
	names := strings.Split(signed[1], ";")
	for _, name := range []string{audienceHeader, "host", "x-amz-date"} {
		if !slices.Contains(names, name) {
			return stsRequest{}, "unsigned_sts_header"
		}
	}
	date := headers["x-amz-date"]
	at, err := time.Parse(amzDateFormat, date)
	if err != nil || at.Format(amzDateFormat) != date || now.Sub(at) > 5*time.Minute || at.Sub(now) > 5*time.Minute {
		return stsRequest{}, "invalid_signing_date"
	}
	send := map[string]string{}
	for _, name := range []string{"authorization", "content-type", "host", "x-amz-date", "x-amz-security-token", audienceHeader} {
		if value, ok := headers[name]; ok {
			send[name] = value
		}
	}
	return stsRequest{"https://" + host + "/", fmt.Sprintf("%x", sha256.Sum256([]byte(auth))), send}, ""
}

// EnrollmentRoles maps the partition, account and role name to a single pool.
// STS assumed-role ARNs omit the IAM role path.
type EnrollmentRoles map[string]string

func ParseEnrollmentRoles(entries string, pools []string) (EnrollmentRoles, error) {
	roles := EnrollmentRoles{}
	for _, entry := range strings.Split(entries, ",") {
		pool, arn, _ := strings.Cut(strings.TrimSpace(entry), "=")
		match := allowedRole.FindStringSubmatch(arn)
		if match == nil || (pool != "build" && pool != "test") || !slices.Contains(pools, pool) {
			return nil, errors.New("enroll-roles must map configured build or test pools to IAM role ARNs")
		}
		key := strings.Join(match[1:], ":")
		if _, exists := roles[key]; exists {
			return nil, errors.New("enroll-roles contains a duplicate role")
		}
		roles[key] = pool
	}
	return roles, nil
}

func awsCaller(body []byte, roles EnrollmentRoles) (host, pool string) {
	arn := callerARN.FindSubmatch(body)
	if arn == nil {
		return "", ""
	}
	match := assumedRole.FindStringSubmatch(string(arn[1]))
	if match == nil || !instanceID.MatchString(match[4]) {
		return "", ""
	}
	return match[4], roles[strings.Join(match[1:4], ":")]
}

type STS interface {
	Do(ctx context.Context, url string, headers map[string]string, body string) (status int, respBody []byte, err error)
}

type stsClient struct{ client *http.Client }

func NewSTS() STS {
	return stsClient{&http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}}
}

func (s stsClient) Do(ctx context.Context, url string, headers map[string]string, body string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Host = headers["host"]
	for name, value := range headers {
		if name != "host" {
			req.Header.Set(name, value)
		}
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	const maxSTSReply = 64 << 10
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxSTSReply+1))
	if len(raw) > maxSTSReply {
		return 0, nil, errors.New("oversized STS response")
	}
	return resp.StatusCode, raw, err
}
