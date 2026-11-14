package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/api"
	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
	"github.com/qaml-ai/run/camelfsd/internal/delivery"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
)

type apiComputeFlags struct {
	tables                                                                               compute.Tables
	endpoint, refs, pools, listenHosts, hostsCA, tierCert, tierKey, notifyURL, notifyKey string
	heartbeat                                                                            time.Duration
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
	f.StringVar(&c.hostsCA, "hosts-ca-pem", "", "private host CA PEM bundle")
	f.StringVar(&c.tierCert, "tier-cert", "", "tier TLS server and client certificate PEM")
	f.StringVar(&c.tierKey, "tier-key", "", "tier TLS private key PEM")
	f.StringVar(&c.notifyURL, "runtime-notify-url", "", "runtime webhook URL")
	f.StringVar(&c.notifyKey, "notify-key-file", "", "runtime webhook HMAC key file")
	f.DurationVar(&c.heartbeat, "heartbeat-interval", 10*time.Second, "host heartbeat interval")
}

type apiCompute struct {
	hostServer  *api.HostServer
	loop        compute.Loop
	sender      delivery.Sender
	credentials *api.HostTLS
}

func (c *apiCompute) reload() error {
	if c == nil {
		return nil
	}
	return c.credentials.Reload()
}

func (f apiComputeFlags) open(ctx context.Context, region string, repo *objects.Repository) (*apiCompute, error) {
	if f.tables == (compute.Tables{}) {
		return nil, nil
	}
	if f.listenHosts == "" {
		return nil, errors.New("compute requires --listen-hosts")
	}
	if slices.Contains([]string{f.tables.VMs, f.tables.Hosts, f.tables.Deliveries, f.tables.Usage, f.refs, f.pools,
		f.hostsCA, f.tierCert, f.tierKey, f.notifyURL, f.notifyKey}, "") || f.heartbeat <= 0 || f.heartbeat > time.Duration(1<<63-1)/3 {
		return nil, errors.New("compute requires all four tables, refs-table, pools, TLS files, notify URL and key, and a valid heartbeat interval")
	}
	pools := strings.Split(f.pools, ",")
	for i := range pools {
		pools[i] = strings.TrimSpace(pools[i])
		if pools[i] == "" || slices.Contains(pools[:i], pools[i]) {
			return nil, errors.New("pools must contain distinct nonempty pool names")
		}
	}
	target, err := url.Parse(f.notifyURL)
	if err != nil || target.Hostname() == "" || target.User != nil || (target.Scheme != "http" && target.Scheme != "https") {
		return nil, errors.New("invalid runtime-notify-url")
	}
	credentials, err := api.LoadHostTLS(f.hostsCA, f.tierCert, f.tierKey)
	if err != nil {
		return nil, err
	}
	key, err := os.ReadFile(f.notifyKey)
	if err != nil {
		return nil, err
	}
	if len(key) == 0 {
		return nil, errors.New("empty notify-key-file")
	}
	node, err := os.Hostname()
	if err != nil {
		return nil, err
	}
	c := &apiCompute{credentials: credentials}
	db, err := ddb.Open(ctx, ddb.Config{Region: region, Endpoint: f.endpoint})
	if err != nil {
		return nil, err
	}
	grace := 3 * f.heartbeat
	controller := &compute.Controller{DB: db, Tables: f.tables, RuntimeURL: f.notifyURL, Objects: repo.Store,
		Refs: refstore.New(db, f.refs, nil, repo), CommitTree: api.CommitTreeResolver(repo),
		Pusher: api.HostPusher{TLS: credentials}, HostFresh: grace}
	c.hostServer = api.NewHostServer(controller, pools, grace)
	c.loop = compute.Loop{C: controller, Pools: func(context.Context) ([]string, error) { return pools, nil }}
	c.sender = delivery.Sender{DB: db, Table: f.tables.Deliveries, Node: node + ":" + strconv.Itoa(os.Getpid()), Signer: delivery.HMAC(key)}
	return c, nil
}

func (c *apiCompute) start(ctx context.Context) func() {
	if c == nil {
		return func() {}
	}
	ctx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	for _, run := range []func(context.Context) error{c.loop.Run, c.sender.Run} {
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
