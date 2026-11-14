package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/qaml-ai/run/camelfsd/internal/guest"
)

func main() {
	args := os.Args[1:]
	if filepath.Base(os.Args[0]) == "camel-init" {
		args = append([]string{"init"}, args...)
	}
	if err := run(args); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func runGuest(args []string) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer stop()
	switch args[0] {
	case "init":
		return guest.Init(ctx)
	case "guest":
		f := flag.NewFlagSet("guest", flag.ContinueOnError)
		root := f.String("root", "/", "guest root")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if os.Getenv("CAMEL_VSOCK_UDS") != "" || *root != "/" {
			return guest.ServeStdio(ctx, *root)
		}
		return guest.ServeVM(ctx, os.Getenv("CAMEL_VSOCK_CONNECT") == "1", nil, false)
	default:
		return fmt.Errorf("usage: camelfsd guest|init")
	}
}
