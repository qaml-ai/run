//go:build linux && kvm

package vmhost

import (
	"context"
	"fmt"
	"net"
	"testing"
	"time"
)

func TestKVMEgressIsolation(t *testing.T) {
	l, shape := kvmLauncher(t)
	// Use the installed camel-egress-proxy.service and its live policy directory.
	l.PolicyDir = "/run/camel/egress"
	online, err := l.Boot(t.Context(), kvmID(t, l, "online"), shape, Boot{Internet: true})
	if err != nil {
		t.Fatal(err)
	}
	offline := kvmBoot(t, l, "offline", shape)

	const registry = "registry.npmjs.org"
	proxyURL := func(vm *VM) string {
		addr, _ := JobAddress(vm.record.Slot)
		return fmt.Sprintf("http://%s:%d", addr.HostIP, ProxyPort)
	}
	probe := func(t *testing.T, vm *VM, url, format string, exit int, result string) {
		t.Helper()
		cmd := fmt.Sprintf("curl -sS -o /dev/null -m 10 --noproxy '' -x %s -w '%%{%s}' %s 2>/dev/null", proxyURL(vm), format, url)
		code, out := kvmRun(t, vm.channel, cmd, 0)
		if code != exit || out != result {
			t.Fatalf("%s via proxy: exit %d, status %q, want exit %d, status %q", url, code, out, exit, result)
		}
	}
	t.Run("allowlisted", func(t *testing.T) {
		probe(t, online, "https://"+registry+"/", "http_code", 0, "200")
	})
	t.Run("off-allowlist", func(t *testing.T) {
		probe(t, online, "https://example.com/", "http_connect", 56, "403")
	})
	t.Run("port-80", func(t *testing.T) {
		probe(t, online, "http://"+registry+"/", "http_code", 0, "403")
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip4", registry)
		if err != nil || len(ips) == 0 {
			t.Fatalf("host lookup of %s: %v, %v", registry, ips, err)
		}
		// A literal IP proves the TCP path is dropped even without guest DNS.
		cmd := fmt.Sprintf("curl -sS -o /dev/null -m 10 --noproxy '*' -H 'Host: %s' http://%s/ 2>/dev/null", registry, ips[0])
		if code, out := kvmRun(t, online.channel, cmd, 0); code != 28 {
			t.Fatalf("direct port 80: exit %d, %q, want timeout", code, out)
		}
	})
	t.Run("offline", func(t *testing.T) {
		probe(t, offline, "https://"+registry+"/", "http_connect", 56, "403")
	})
	t.Run("imds", func(t *testing.T) {
		probe(t, online, "https://169.254.169.254/latest/meta-data/", "http_connect", 56, "403")
	})
}
