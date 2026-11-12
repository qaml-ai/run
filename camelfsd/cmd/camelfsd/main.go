package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/api"
	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/client"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/nbd"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"golang.org/x/sys/unix"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const version = "0.1.0"

type dirs []string

func (d *dirs) String() string { return strings.Join(*d, ",") }
func (d *dirs) Set(s string) error {
	if !filepath.IsAbs(s) {
		return fmt.Errorf("import-allow must be absolute")
	}
	*d = append(*d, s)
	return nil
}
func main() {
	if e := run(os.Args[1:]); e != nil {
		log.Print(e)
		os.Exit(1)
	}
}
func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: camelfsd host|client|version")
	}
	switch args[0] {
	case "version":
		fmt.Println(version)
		return nil
	case "client":
		return client.Run(args[1:], os.Stdout)
	case "host":
		return host(args[1:])
	default:
		return fmt.Errorf("unknown subcommand")
	}
}
func host(args []string) error {
	f := flag.NewFlagSet("host", flag.ContinueOnError)
	socket := f.String("socket", "/run/camelfsd/api.sock", "Unix socket")
	data := f.String("data", "/nvme/camelfs", "data directory")
	url := f.String("store", "", "s3://bucket/prefix or local directory")
	region := f.String("region", "us-west-2", "AWS region")
	cold := f.String("cold", "clone", "clone or prehydrate")
	listen := f.String("nbd-listen", "127.0.0.1:10809", "NBD address")
	depth := f.Int("prefetch-depth", 4, "prefetch depth")
	var allow dirs
	f.Var(&allow, "import-allow", "allowed import directory (repeatable)")
	if e := f.Parse(args); e != nil {
		return e
	}
	if !filepath.IsAbs(*data) || !filepath.IsAbs(*socket) || *url == "" || *depth < 1 {
		return fmt.Errorf("invalid host flags")
	}
	if e := os.MkdirAll(*data, 0700); e != nil {
		return e
	}
	lock, e := os.OpenFile(filepath.Join(*data, "host.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer lock.Close()
	if e = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); e != nil {
		return fmt.Errorf("data is in use: %w", e)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	s, e := store.Open(ctx, *url, *region)
	if e != nil {
		return e
	}
	r, e := refs.Open(filepath.Join(*data, "refs.db"))
	if e != nil {
		return e
	}
	defer r.Close()
	machine, e := os.ReadFile("/etc/machine-id")
	if e != nil {
		return e
	}
	hostID := fmt.Sprintf("%s-%d", strings.TrimSpace(string(machine)), time.Now().UnixNano())
	c := cache.New(filepath.Join(*data, "cache"), s, *depth)
	m, e := image.New(image.Config{Data: *data, Cold: *cold, NBDListen: *listen, HostID: hostID, ImportAllow: allow}, s, c, r)
	if e != nil {
		return e
	}
	defer m.Close()
	nl, e := net.Listen("tcp", *listen)
	if e != nil {
		return e
	}
	defer nl.Close()
	go func() { _ = (&nbd.Server{Store: s, Cache: c, Prefetch: *depth}).Serve(nl) }()
	if e = os.MkdirAll(filepath.Dir(*socket), 0700); e != nil {
		return e
	}
	if st, e := os.Lstat(*socket); e == nil {
		if st.Mode()&os.ModeSocket == 0 {
			return fmt.Errorf("socket path exists and is not a socket")
		}
		conn, e := net.DialTimeout("unix", *socket, time.Second)
		if e == nil {
			conn.Close()
			return fmt.Errorf("socket in use")
		}
		if e = os.Remove(*socket); e != nil {
			return e
		}
	}
	ul, e := net.Listen("unix", *socket)
	if e != nil {
		return e
	}
	defer os.Remove(*socket)
	defer ul.Close()
	if e = os.Chmod(*socket, 0600); e != nil {
		return e
	}
	server := http.Server{Handler: &api.Server{Manager: m, Version: version, Store: *url}, ReadHeaderTimeout: 5 * time.Second}

	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("op=host hostId=%s data=%s socket=%s", hostID, *data, *socket)
	e = server.Serve(ul)
	if errors.Is(e, http.ErrServerClosed) {
		return nil
	}
	return e
}
