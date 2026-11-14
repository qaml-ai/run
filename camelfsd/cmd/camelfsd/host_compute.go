//go:build !guest

package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/computehost"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/vmhost"
)

type hostComputeFlags struct {
	enabled                                                      bool
	tierCAPath                                                   string
	tierCA                                                       *computehost.TierCA
	listen, tier, enroll, pool, images, attestor, audience, addr string
	firecracker, jailer, kernel, initrd, policy                  string
	slots                                                        int
	shape                                                        hostwire.Shape
}

func addHostComputeFlags(f *flag.FlagSet) *hostComputeFlags {
	c := new(hostComputeFlags)
	f.BoolVar(&c.enabled, "compute", false, "run the session VM host")
	f.StringVar(&c.listen, "listen-compute", "0.0.0.0:8792", "tier-to-host mTLS listener")
	f.StringVar(&c.tier, "tier-hosts-endpoint", "", "tier host mTLS endpoint (host:port)")
	f.StringVar(&c.tierCAPath, "tier-ca", "", "pinned tier CA PEM file")
	f.StringVar(&c.enroll, "tier-enroll-url", "", "tier HTTPS enrollment URL")
	f.StringVar(&c.pool, "pool", "", "AWS enrollment and placement pool (build or test)")
	f.StringVar(&c.images, "images-store", "", "guest image S3 bucket and optional prefix")
	f.StringVar(&c.attestor, "attestor", "aws", "host enrollment attestor")
	f.StringVar(&c.audience, "enroll-audience", "camelfs:enroll", "signed STS enrollment audience")
	f.StringVar(&c.addr, "compute-advertise", "", "compute address advertised to the tier (defaults to the private route IP)")
	f.IntVar(&c.slots, "slots", 0, "maximum concurrent VMs")
	f.IntVar(&c.shape.VCPUs, "vcpus", 0, "vCPU cap")
	f.IntVar(&c.shape.MemoryMiB, "memory-mib", 0, "host memory cap in MiB")
	f.IntVar(&c.shape.DiskMiB, "disk-mib", 0, "guest root disk cap in MiB")
	f.StringVar(&c.firecracker, "firecracker", "/usr/local/bin/firecracker", "Firecracker executable")
	f.StringVar(&c.jailer, "jailer", "/usr/local/bin/jailer", "Firecracker jailer executable")
	f.StringVar(&c.kernel, "guest-kernel", "/var/lib/camel/guest/vmlinux", "guest kernel")
	f.StringVar(&c.initrd, "guest-initrd", "", "guest initrd")
	f.StringVar(&c.policy, "egress-policies", "/run/camel/egress", "egress proxy policies directory")
	return c
}

func validEndpoint(endpoint string) bool {
	host, port, err := net.SplitHostPort(endpoint)
	n, portErr := strconv.ParseUint(port, 10, 16)
	return err == nil && host != "" && !strings.ContainsAny(host, "/\\?#@% \t\r\n") && portErr == nil && n > 0
}

func (c *hostComputeFlags) validate() error {
	if !c.enabled {
		return errors.New("host requires --compute")
	}
	if !validEndpoint(c.tier) || c.enroll == "" || c.attestor != "aws" || (c.pool != "build" && c.pool != "test") ||
		!strings.HasPrefix(c.images, "s3://") || c.slots <= 0 || c.slots > vmhost.MaxSlots ||
		c.shape.VCPUs <= 0 || c.shape.MemoryMiB <= 0 || c.shape.DiskMiB <= 0 || c.audience == "" ||
		c.addr != "" && !validEndpoint(c.addr) {
		return errors.New("invalid compute host flags")
	}
	var err error
	c.tierCA, err = computehost.LoadTierCA(c.tierCAPath)
	return err
}

func (c *hostComputeFlags) start(ctx context.Context, data, region string, m *image.Manager, onError func()) (func(), error) {
	listener, err := net.Listen("tcp", c.listen)
	if err != nil {
		return nil, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			listener.Close()
		}
	}()
	addr := c.addr
	if addr == "" {
		ip := listener.Addr().(*net.TCPAddr).IP
		if ip.IsUnspecified() {
			dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			conn, err := (&net.Dialer{}).DialContext(dialCtx, "udp", c.tier)
			cancel()
			if err != nil {
				return nil, fmt.Errorf("compute advertise address: %w", err)
			}
			ip = conn.LocalAddr().(*net.UDPAddr).IP
			conn.Close()
		}
		addr = net.JoinHostPort(ip.String(), strconv.Itoa(listener.Addr().(*net.TCPAddr).Port))
	}
	boot, err := computehost.KernelBootID()
	if err != nil {
		return nil, err
	}
	identityCtx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	id, attest, err := computehost.AWSIdentity(identityCtx, region, c.audience)
	if err != nil {
		return nil, err
	}
	identity, err := computehost.NewIdentity(identityCtx, data, id, c.pool, c.tier, c.enroll, c.tierCA, attest)
	if err != nil {
		return nil, err
	}
	images, err := store.Open(ctx, c.images, region)
	if err != nil {
		return nil, err
	}
	launcher := &vmhost.Launcher{Firecracker: c.firecracker, Jailer: c.jailer, Kernel: c.kernel, Initrd: c.initrd, PolicyDir: c.policy,
		Work: filepath.Join(data, "compute"), KVM: true, Build: c.pool == "build", Reflink: "always"}
	h, err := computehost.Open(ctx, computehost.Config{Data: data, BootID: boot, HostID: id, Pool: c.pool, Addr: addr,
		Slots: c.slots, Shape: c.shape, Mounts: m, Images: images, Launcher: launcher, Post: identity.Post})
	if err != nil {
		return nil, err
	}
	if err := h.Recover(ctx); err != nil {
		h.Close()
		return nil, err
	}
	server := &http.Server{Handler: h.Handler(), ReadHeaderTimeout: 5 * time.Second, TLSConfig: identity.ServerTLS(),
		BaseContext: func(net.Listener) context.Context { return ctx }}
	run, cancelRun := context.WithCancel(ctx)
	stopped := make(chan struct{})
	rotated := make(chan struct{})
	served := make(chan struct{})
	go func() { defer close(stopped); h.Run(run) }()
	go func() { defer close(rotated); identity.Rotate(run) }()
	go func() {
		defer close(served)
		if err := server.Serve(tls.NewListener(listener, server.TLSConfig)); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("compute listener stopped: %v", err)
			onError()
		}
	}()
	cleanup = false
	log.Printf("op=compute-listen addr=%s hostId=%s pool=%s pid=%d", addr, id, c.pool, os.Getpid())
	return func() {
		cancelRun()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if server.Shutdown(shutdown) != nil {
			_ = server.Close()
		}
		<-served
		<-stopped
		<-rotated
		h.Close()
	}, nil
}
