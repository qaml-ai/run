//go:build !guest

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/api"
	"github.com/qaml-ai/run/camelfsd/internal/auth"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func apiRole(args []string) error {
	f := flag.NewFlagSet("api", flag.ContinueOnError)
	listen := f.String("listen", "127.0.0.1:8790", "storage API address")
	data := f.String("data", "", "local cache directory")
	url := f.String("store", "", "s3://bucket/prefix or local directory")
	region := f.String("region", "us-west-2", "AWS region")
	fetchDepth := f.Int("fetch-depth", store.DefaultDepth, "maximum in-flight fetches and uploads")
	jwksFile := f.String("jwks-file", "", "runtime JWKS file (alternative to CAMELFS_JWKS)")
	issuer := f.String("token-issuer", "", "runtime issuer URL")
	maxTTL := f.Duration("token-max-ttl", auth.DefaultMaxTTL, "maximum token lifetime")
	var computeFlags apiComputeFlags
	computeFlags.bind(f)
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 || *listen == "" || !filepath.IsAbs(*data) || *url == "" || *fetchDepth < 1 {
		return fmt.Errorf("invalid api flags")
	}
	var inline *string
	if value, ok := os.LookupEnv("CAMELFS_JWKS"); ok {
		inline = &value
	}
	keys, err := auth.Load(*jwksFile, inline, auth.Options{Typ: auth.RuntimeType, Audience: auth.RuntimeAudience, Issuer: *issuer, MaxTTL: *maxTTL})
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)

	st, err := store.Open(ctx, *url, *region, *fetchDepth)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(*data, 0700); err != nil {
		return err
	}
	db, err := refs.OpenStorage(filepath.Join(*data, "storage.db"))
	if err != nil {
		return err
	}
	defer db.Close()
	// The task's root filesystem is read-only: every temporary file lives under --data.
	tmp := filepath.Join(*data, "tmp")
	if err := os.RemoveAll(tmp); err != nil {
		return err
	}
	if err := os.MkdirAll(tmp, 0700); err != nil {
		return err
	}
	repo := &objects.Repository{DB: db, Store: st, TempDir: tmp}
	computeAPI, err := computeFlags.open(ctx, *region, repo)
	if err != nil {
		return err
	}
	var hosts *api.HostServer
	if computeAPI != nil {
		hosts = computeAPI.hostServer
	}
	server := &http.Server{Handler: api.WithHostRoutes(api.NewStorageServer(repo, version, keys), hosts), ReadHeaderTimeout: 5 * time.Second}
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	defer computeAPI.start(ctx)()
	stopped := make(chan error, 1)
	go func() { stopped <- server.Serve(listener) }()
	log.Printf("op=api listen=%s", listener.Addr())
	for {
		select {
		case err := <-stopped:
			return err
		case <-hup:
			if err := keys.Reload(); err != nil {
				log.Printf("op=jwks-reload error=%v", err)
			}
			if err := computeAPI.reload(); err != nil {
				log.Printf("op=hosts-ca-reload error=%v", err)
			}
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := server.Shutdown(shutdown); err != nil {
				_ = server.Close()
				return err
			}
			if err := <-stopped; !errors.Is(err, http.ErrServerClosed) {
				return err
			}
			return nil
		}
	}
}
