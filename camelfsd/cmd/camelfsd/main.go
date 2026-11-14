//go:build !guest

package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"golang.org/x/sys/unix"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

const version = "0.1.0"

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: camelfsd host|api|cleanup|version|guest|init|egress")
	}
	switch args[0] {
	case "guest", "init":
		return runGuest(args)
	case "version":
		fmt.Println(version)
		return nil
	case "cleanup":
		f := flag.NewFlagSet("cleanup", flag.ContinueOnError)
		data := f.String("data", "", "data directory")
		if e := f.Parse(args[1:]); e != nil {
			return e
		}
		if *data == "" {
			return fmt.Errorf("data required")
		}
		return image.Cleanup(context.Background(), *data, nil)
	case "api":
		return apiRole(args[1:])
	case "egress":
		return runEgress(args[1:])
	case "host":
		return host(args[1:])
	default:
		return fmt.Errorf("unknown subcommand")
	}
}
func host(args []string) error {
	f := flag.NewFlagSet("host", flag.ContinueOnError)
	data := f.String("data", "/nvme/camelfs", "data directory")
	url := f.String("store", "", "s3://bucket/prefix or local directory")
	region := f.String("region", "us-west-2", "AWS region")
	fetchDepth := f.Int("fetch-depth", store.DefaultDepth, "maximum in-flight fetches and uploads")
	virtualSize := f.Int64("virtual-size", 1<<30, "blank image size")
	maxFiles := f.Int("max-files", 200000, "checkpoint file cap")
	maxBytes := f.Int64("max-bytes", 8<<30, "checkpoint byte cap")
	maxPaths := f.Int64("max-paths-bytes", 64<<20, "checkpoint path byte cap")
	streamIdle := f.Duration("stream-idle", 30*time.Second, "guest stream idle timeout")
	applyMax := f.Duration("apply-max", 30*time.Minute, "apply overall cap")
	compute := addHostComputeFlags(f)
	if e := f.Parse(args); e != nil {
		return e
	}
	if !filepath.IsAbs(*data) || *url == "" || *fetchDepth < 1 {
		return fmt.Errorf("invalid host flags")
	}
	if e := compute.validate(); e != nil {
		return e
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
	s, e := store.Open(ctx, *url, *region, *fetchDepth)
	if e != nil {
		return e
	}
	r, e := refs.Open(filepath.Join(*data, "refs.db"))
	if e != nil {
		return e
	}
	defer r.Close()
	c := cache.New(filepath.Join(*data, "cache"), s, *fetchDepth)
	m, e := image.New(image.Config{StreamIdle: *streamIdle, ApplyMax: *applyMax, VirtualSize: *virtualSize, MaxFiles: *maxFiles, MaxBytes: *maxBytes, MaxPathsBytes: *maxPaths, Data: *data}, s, c, r)
	if e != nil {
		return e
	}
	defer m.Close()
	stop, err := compute.start(ctx, *data, *region, m, cancel)
	if err != nil {
		return err
	}
	defer stop()
	<-ctx.Done()
	return nil
}
