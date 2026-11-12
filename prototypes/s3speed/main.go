package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
)

type options struct {
	bucket, prefix, region, layouts, mode, out, label, store string
	chunks, chunkKiB, concurrency, n, sizeKiB                int
	seed, subsetSeed                                         int64
	subset                                                   float64
	keep, cold, header                                       bool
	prices                                                   prices
}

func parse(args []string) (string, options, error) {
	var o options
	if len(args) == 0 {
		return "", o, fmt.Errorf("usage: s3speed upload|fetch|latency|cleanup [flags]")
	}
	cmd := args[0]
	f := flag.NewFlagSet(cmd, flag.ContinueOnError)
	f.StringVar(&o.bucket, "bucket", "", "S3 bucket")
	f.StringVar(&o.prefix, "prefix", "", "required key prefix")
	f.StringVar(&o.region, "region", "us-west-2", "AWS region")
	if cmd == "upload" || cmd == "fetch" {
		f.IntVar(&o.chunks, "chunks", 0, "number of chunks")
		f.IntVar(&o.chunkKiB, "chunk-kib", 256, "chunk size in KiB")
		f.IntVar(&o.concurrency, "concurrency", 64, "worker count")
		f.Int64Var(&o.seed, "seed", 1, "data seed")
	}
	switch cmd {
	case "upload":
		f.StringVar(&o.layouts, "layouts", "chunk,pack1m,pack4m", "comma-separated layouts")
	case "fetch":
		f.StringVar(&o.mode, "mode", "chunk", "fetch mode")
		f.StringVar(&o.out, "out", "", "required output file")
		f.Float64Var(&o.subset, "subset", 1, "fraction of chunks")
		f.Int64Var(&o.subsetSeed, "subset-seed", 1, "subset selection seed (data uses --seed)")
		f.BoolVar(&o.keep, "keep", false, "keep output")
		f.BoolVar(&o.cold, "cold-client", false, "skip client warm-up")
		f.Float64Var(&o.prices.standard, "price-get-per-1k-standard", 0.0004, "standard GET price")
		f.Float64Var(&o.prices.express, "price-get-per-1k-express", 0.00003, "Express GET price")
		f.Float64Var(&o.prices.retrieval, "price-retrieval-per-gb-express", 0.0006, "Express retrieval price")
	case "latency":
		f.IntVar(&o.n, "n", 200, "warm GET count")
		f.IntVar(&o.sizeKiB, "size-kib", 4, "object size in KiB")
	case "cleanup":
	default:
		return cmd, o, fmt.Errorf("unknown command %q", cmd)
	}
	if cmd == "fetch" || cmd == "latency" {
		f.StringVar(&o.label, "label", "", "CSV label")
		f.StringVar(&o.store, "store", "", "store label")
		f.BoolVar(&o.header, "csv-header", false, "emit CSV header")
	}
	if err := f.Parse(args[1:]); err != nil {
		return cmd, o, err
	}
	if f.NArg() != 0 {
		return cmd, o, fmt.Errorf("unexpected positional arguments")
	}
	o.prefix = strings.TrimRight(o.prefix, "/")
	if o.bucket == "" || o.prefix == "" {
		return cmd, o, fmt.Errorf("--bucket and --prefix are required")
	}
	if cmd == "upload" || cmd == "fetch" {
		if o.chunks <= 0 || o.chunkKiB <= 0 || o.chunkKiB > int(^uint(0)>>1)/1024 || o.concurrency <= 0 {
			return cmd, o, fmt.Errorf("chunks, chunk-kib, concurrency must be positive")
		}
		if int64(o.chunks) > int64(^uint64(0)>>1)/int64(o.chunkKiB*1024) {
			return cmd, o, fmt.Errorf("output size overflows int64")
		}
	}
	if cmd == "fetch" && (o.out == "" || !(o.subset > 0 && o.subset <= 1)) {
		return cmd, o, fmt.Errorf("--out and 0 < --subset <= 1 required")
	}
	if cmd == "latency" && (o.n <= 0 || o.sizeKiB <= 0 || o.sizeKiB > int(^uint(0)>>1)/1024) {
		return cmd, o, fmt.Errorf("n and size-kib must be positive")
	}
	if !(o.prices.standard >= 0 && o.prices.express >= 0 && o.prices.retrieval >= 0) {
		return cmd, o, fmt.Errorf("prices must be nonnegative")
	}
	if o.store == "" {
		o.store = "standard"
		if strings.HasSuffix(o.bucket, "--x-s3") {
			o.store = "express"
		}
	}
	return cmd, o, nil
}
func run() error {
	cmd, o, err := parse(os.Args[1:])
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	switch cmd {
	case "upload":
		return upload(ctx, o)
	case "fetch":
		return fetch(ctx, o)
	case "latency":
		return latency(ctx, o)
	case "cleanup":
		return cleanup(ctx, o)
	}
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "s3speed:", err)
		os.Exit(1)
	}
}
