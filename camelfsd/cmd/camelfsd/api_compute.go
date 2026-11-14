//go:build !guest

package main

import (
	"context"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws/arn"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/acmpca"

	"github.com/qaml-ai/run/camelfsd/internal/api"
	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
	"github.com/qaml-ai/run/camelfsd/internal/delivery"
	"github.com/qaml-ai/run/camelfsd/internal/hostcert"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

type apiComputeFlags struct {
	tables                                                                                  compute.Tables
	endpoint, refs, pools, listenHosts, hostsCAPEM, tierCert, tierKey, notifyURL, notifyKey string
	listenEnroll, enrollAudience, enrollRoles, hostsCA                                      string
	heartbeat                                                                               time.Duration
	guestImages, idleStop                                                                   string
}

func (c *apiComputeFlags) bind(f *flag.FlagSet) {
	f.StringVar(&c.tables.VMs, "vms-table", "", "DynamoDB VMs table")
	f.StringVar(&c.tables.Hosts, "hosts-table", "", "DynamoDB hosts table")
	f.StringVar(&c.tables.Deliveries, "deliveries-table", "", "DynamoDB deliveries table")
	f.StringVar(&c.tables.Usage, "usage-table", "", "DynamoDB usage table")
	f.StringVar(&c.refs, "refs-table", "", "DynamoDB refs table for VM mount leases")
	f.StringVar(&c.endpoint, "ddb-endpoint", "", "DynamoDB Local endpoint for tests")
	f.StringVar(&c.pools, "pools", "", "comma-separated compute pools")
	f.StringVar(&c.listenHosts, "listen-hosts", "", "private host mTLS address (required with compute, no unauthenticated routes, use TCP NLB health checks)")
	f.StringVar(&c.listenEnroll, "listen-enroll", "", "host enrollment TLS address (the tier's Private-CA certificate, no client certificate; behind a TCP-passthrough NLB)")
	f.StringVar(&c.enrollAudience, "enroll-audience", "", "signed STS enrollment audience")
	f.StringVar(&c.enrollRoles, "enroll-roles", "", "comma-separated pool=IAM role ARN mappings")
	f.StringVar(&c.hostsCA, "hosts-ca", "", "AWS Private CA ARN for host and tier certificates")
	f.StringVar(&c.hostsCAPEM, "hosts-ca-pem", "", "private host CA PEM bundle")
	f.StringVar(&c.tierCert, "tier-cert", "", "tier TLS server and client certificate PEM")
	f.StringVar(&c.tierKey, "tier-key", "", "tier TLS private key PEM")
	f.StringVar(&c.notifyURL, "runtime-notify-url", "", "runtime webhook URL")
	f.StringVar(&c.notifyKey, "notify-key-file", "", "raw runtime webhook HMAC key file (alternative to CAMELFS_NOTIFY_KEY)")
	f.StringVar(&c.guestImages, "guest-images", os.Getenv("GUEST_IMAGE_SHA256"), "comma-separated allowed guest image SHA-256s")
	f.StringVar(&c.idleStop, "idle-stop", "", "comma-separated pool=seconds session idle overrides")
	f.DurationVar(&c.heartbeat, "heartbeat-interval", 10*time.Second, "host heartbeat interval")
}

type apiCompute struct {
	images, pools []string
	idle          map[string]int64
	hostServer    *api.HostServer
	enrollServer  http.Handler
	issuer        hostcert.Issuer
	loop          compute.Loop
	sender        delivery.Sender
	credentials   *api.HostTLS
}

func (c *apiCompute) reload() error {
	if c == nil {
		return nil
	}
	return c.credentials.Reload()
}

func (f apiComputeFlags) open(ctx context.Context, region string, repo *objects.Repository) (*apiCompute, error) {
	if f.tables == (compute.Tables{}) {
		if f.listenEnroll != "" || f.hostsCA != "" || f.enrollAudience != "" || f.enrollRoles != "" {
			return nil, errors.New("host enrollment and Private CA require compute")
		}
		return nil, nil
	}
	hasFiles := f.hostsCAPEM != "" || f.tierCert != "" || f.tierKey != ""
	if f.hostsCA != "" && hasFiles {
		return nil, errors.New("--hosts-ca cannot be combined with --hosts-ca-pem, --tier-cert or --tier-key")
	}
	if f.hostsCA == "" && slices.Contains([]string{f.hostsCAPEM, f.tierCert, f.tierKey}, "") {
		return nil, errors.New("compute requires --hosts-ca or all three TLS files")
	}
	if f.listenEnroll != "" && (f.hostsCA == "" || strings.TrimSpace(f.enrollAudience) == "" || f.enrollRoles == "") {
		return nil, errors.New("--listen-enroll requires --hosts-ca, --enroll-audience and --enroll-roles")
	}
	if f.listenEnroll == "" && (f.enrollAudience != "" || f.enrollRoles != "") {
		return nil, errors.New("enrollment settings require --listen-enroll")
	}
	if f.listenHosts == "" {
		return nil, errors.New("compute requires --listen-hosts")
	}
	if slices.Contains([]string{f.tables.VMs, f.tables.Hosts, f.tables.Deliveries, f.tables.Usage, f.refs, f.pools,
		f.notifyURL}, "") || f.heartbeat <= 0 || f.heartbeat > time.Duration(1<<63-1)/3 {
		return nil, errors.New("compute requires all four tables, refs-table, pools, notify URL, and a valid heartbeat interval")
	}
	pools := strings.Split(f.pools, ",")
	for i := range pools {
		pools[i] = strings.TrimSpace(pools[i])
		if pools[i] == "" || slices.Contains(pools[:i], pools[i]) {
			return nil, errors.New("pools must contain distinct nonempty pool names")
		}
	}
	var images []string
	if f.guestImages != "" {
		images = strings.Split(f.guestImages, ",")
	}
	for i := range images {
		images[i] = strings.TrimSpace(images[i])
		if !root.Hex(images[i], 64) {
			return nil, errors.New("--guest-images requires 64-character SHA-256 values")
		}
	}
	idle, err := parseIdleStop(f.idleStop, pools)
	if err != nil {
		return nil, err
	}
	var roles api.EnrollmentRoles
	if f.listenEnroll != "" {
		var err error
		roles, err = api.ParseEnrollmentRoles(f.enrollRoles, pools)
		if err != nil {
			return nil, err
		}
	}
	target, err := url.Parse(f.notifyURL)
	if err != nil || target.Hostname() == "" || target.User != nil || (target.Scheme != "http" && target.Scheme != "https") {
		return nil, errors.New("invalid runtime-notify-url")
	}
	key, err := loadNotifyKey(f.notifyKey)
	if err != nil {
		return nil, err
	}
	node, err := os.Hostname()
	if err != nil {
		return nil, err
	}
	credentials, issuer, err := f.openTLS(ctx)
	if err != nil {
		return nil, err
	}
	c := &apiCompute{credentials: credentials, issuer: issuer, images: images, pools: pools, idle: idle}
	db, err := ddb.Open(ctx, ddb.Config{Region: region, Endpoint: f.endpoint})
	if err != nil {
		return nil, err
	}
	grace := 3 * f.heartbeat
	controller := &compute.Controller{DB: db, Tables: f.tables, RuntimeURL: f.notifyURL, Objects: repo.Store,
		Refs: refstore.New(db, f.refs, nil, repo), CommitTree: api.CommitTreeResolver(repo),
		Pusher: api.HostPusher{TLS: credentials}, HostFresh: grace}
	controller.EnableClockCheck()
	// MONEY: a compute process whose usage writes would all be refused must not start.
	if err := requireClockCheck(controller); err != nil {
		return nil, err
	}
	c.hostServer = api.NewHostServer(controller, pools, grace)
	if issuer != nil {
		certificates := api.HostCertificates{Issuer: issuer, TLS: credentials}
		c.hostServer.EnableRenewal(certificates)
		if f.listenEnroll != "" {
			c.enrollServer = api.EnrollmentServer{Audience: f.enrollAudience, Roles: roles, STS: api.NewSTS(),
				Record: controller.RecordEnrollment, Certificates: certificates}
		}
	}
	c.loop = compute.Loop{C: controller, Enrollment: issuer != nil, Pools: func(context.Context) ([]string, error) { return pools, nil }}
	c.sender = delivery.Sender{DB: db, Table: f.tables.Deliveries, Node: node + ":" + strconv.Itoa(os.Getpid()), Signer: delivery.HMAC(key)}
	return c, nil
}

func loadNotifyKey(path string) ([]byte, error) {
	value, hasEnv := os.LookupEnv("CAMELFS_NOTIFY_KEY")
	if hasEnv == (path != "") {
		return nil, errors.New("set exactly one of CAMELFS_NOTIFY_KEY or --notify-key-file")
	}
	var key []byte
	var err error
	if hasEnv {
		key, err = hex.DecodeString(value)
		if err != nil {
			return nil, errors.New("CAMELFS_NOTIFY_KEY must be hex")
		}
	} else {
		key, err = os.ReadFile(path)
		if err != nil {
			return nil, err
		}
	}
	if len(key) < 32 {
		return nil, errors.New("notify HMAC key must be at least 32 bytes")
	}
	return key, nil
}

func (f apiComputeFlags) openTLS(ctx context.Context) (*api.HostTLS, hostcert.Issuer, error) {
	if f.hostsCA == "" {
		tls, err := api.LoadHostTLS(f.hostsCAPEM, f.tierCert, f.tierKey)
		return tls, nil, err
	}
	ca, err := arn.Parse(f.hostsCA)
	if err != nil || ca.Service != "acm-pca" || ca.Region == "" || ca.AccountID == "" ||
		!strings.HasPrefix(ca.Resource, "certificate-authority/") {
		return nil, nil, errors.New("invalid --hosts-ca ARN")
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(ca.Region))
	if err != nil {
		return nil, nil, err
	}
	issuer, err := hostcert.NewPCA(ctx, acmpca.NewFromConfig(cfg), f.hostsCA)
	if err != nil {
		return nil, nil, err
	}
	tls, err := api.IssueHostTLS(ctx, issuer)
	return tls, issuer, err
}

func (c *apiCompute) start(ctx context.Context) func() {
	if c == nil {
		return func() {}
	}
	ctx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	workers := []func(context.Context) error{c.loop.Run, c.sender.Run}
	if c.issuer != nil {
		workers = append(workers, func(ctx context.Context) error { return c.credentials.Rotate(ctx, c.issuer) })
	}
	for _, run := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := run(ctx); err != nil && ctx.Err() == nil {
				log.Printf("op=compute_worker error=%v", err)
			}
		}()
	}
	return func() {
		cancel()
		wg.Wait()
	}
}

func parseIdleStop(value string, pools []string) (map[string]int64, error) {
	overrides := make(map[string]int64)
	if value == "" {
		return overrides, nil
	}
	for entry := range strings.SplitSeq(value, ",") {
		pool, seconds, _ := strings.Cut(strings.TrimSpace(entry), "=")
		idle, err := strconv.ParseInt(seconds, 10, 64)
		if !slices.Contains(pools, pool) || err != nil || !compute.ValidIdleStop(idle) || overrides[pool] != 0 {
			return nil, fmt.Errorf("--idle-stop: invalid or repeated pool=seconds entry %q", entry)
		}
		overrides[pool] = idle
	}
	return overrides, nil
}

// requireClockCheck refuses to start compute without the DynamoDB clock check: an un-enabled controller refuses every
// usage write, so a config slip would silently stop billing.
func requireClockCheck(c *compute.Controller) error {
	if !c.ClockCheckEnabled() {
		return errors.New("compute: the DynamoDB clock check is not enabled; refusing to start (usage writes would all be refused)")
	}
	return nil
}
