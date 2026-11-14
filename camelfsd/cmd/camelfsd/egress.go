//go:build linux && !guest

package main

import (
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/egress"
	"github.com/qaml-ai/run/camelfsd/internal/vmhost"
)

func runEgress(args []string) error {
	flags := flag.NewFlagSet("egress", flag.ContinueOnError)
	policies := flags.String("policies", "/run/camel/egress", "guest policy directory")
	listen := flags.String("listen", "0.0.0.0", "listener address (port defaults to 3128)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if !filepath.IsAbs(*policies) || *listen == "" || flags.NArg() != 0 {
		return fmt.Errorf("invalid egress flags")
	}
	address := *listen
	if _, _, err := net.SplitHostPort(address); err != nil {
		address = net.JoinHostPort(address, strconv.Itoa(vmhost.ProxyPort))
	}
	server := &http.Server{
		Addr:                         address,
		Handler:                      egress.NewHandler(*policies, os.Stdout),
		ReadHeaderTimeout:            10 * time.Second,
		DisableGeneralOptionsHandler: true,
	}
	return server.ListenAndServe()
}
