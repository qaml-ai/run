package egress

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAllowed(t *testing.T) {
	allow := []string{"registry.npmjs.org", "*.github.com"}
	for _, tc := range []struct {
		host  string
		rules []string
		want  bool
	}{
		{"registry.npmjs.org", allow, true},
		{"REGISTRY.npmjs.org", allow, true},
		{"api.github.com", allow, true},
		{"github.com", allow, false},
		{"evilgithub.com", allow, false},
		{"registry.npmjs.org.evil.example", allow, false},
		{"169.254.169.254", []string{"169.254.169.254"}, false},
		{"a..b.com", []string{"a..b.com"}, false},
	} {
		if got := allowed(tc.host, tc.rules); got != tc.want {
			t.Errorf("allowed(%q) = %v, want %v", tc.host, got, tc.want)
		}
	}
}

func TestPublicAddress(t *testing.T) {
	for _, raw := range []string{
		"0.0.0.0", "10.0.0.2", "100.64.0.1", "100.127.255.255", "127.0.0.1",
		"169.254.169.254", "172.16.5.4", "172.31.255.255", "192.0.0.1", "192.0.255.1", "192.168.1.1",
		"198.18.0.1", "198.19.255.255", "224.0.0.1", "240.0.0.1", "255.255.255.255",
		"::", "::1", "0:0:0:0:0:0:0:1", "::ffff:169.254.169.254", "::ffff:8.8.8.8",
		"0:0:0:0:0:ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "fc00::1",
		"fd00:ec2::254", "fe80::1", "fe80::1%eth0", "febf::1", "ff02::1", "not-an-ip",
	} {
		ip, _ := netip.ParseAddr(raw)
		if publicAddress(ip) {
			t.Errorf("accepted %s", raw)
		}
	}
	for _, raw := range []string{
		"140.82.112.3", "104.16.0.1", "203.0.113.10", "2606:4700::6810:1",
		"100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0",
	} {
		if !publicAddress(netip.MustParseAddr(raw)) {
			t.Errorf("refused %s", raw)
		}
	}
}

func TestConnect(t *testing.T) {
	dir := t.TempDir()
	policy := filepath.Join(dir, "10.200.1.2.json")
	if err := os.WriteFile(policy, []byte(`{"job":"job-1","allow":["allowed.test","rebind.test"]}`), 0644); err != nil {
		t.Fatal(err)
	}
	var events []event
	var dialled []string
	var allowedLookups int
	p := &proxy{
		policyDir: dir, open: make(map[string]int),
		log: func(e event) { events = append(events, e) },
		lookup: func(_ context.Context, host string) ([]netip.Addr, error) {
			switch host {
			case "allowed.test":
				allowedLookups++
				return []netip.Addr{netip.MustParseAddr("203.0.113.10")}, nil
			case "rebind.test":
				return []netip.Addr{netip.MustParseAddr("203.0.113.10"), netip.MustParseAddr("169.254.169.254")}, nil
			default:
				t.Fatalf("unexpected lookup of %q", host)
				return nil, nil
			}
		},
		dial: func(_ context.Context, network, addr string) (net.Conn, error) {
			dialled = append(dialled, network+" "+addr)
			conn, peer := net.Pipe()
			peer.Close()
			return conn, nil
		},
	}

	for _, tc := range []struct {
		method, target, source, reason string
	}{
		{"GET", "http://allowed.test/private?secret=1", "10.200.1.2:1234", "not_connect"},
		{"POST", "/private?secret=1", "10.200.1.2:1234", "not_connect"},
		{"CONNECT", "allowed.test:443/private?secret=1", "10.200.1.2:1234", "bad_target"},
		{"CONNECT", "allowed.test:80", "10.200.1.2:1234", "port"},
		{"CONNECT", "allowed.test:00443", "10.200.1.2:1234", "port"},
		{"CONNECT", "allowed.test:443", "10.200.1.3:1234", "no_policy"},
		{"CONNECT", "allowed.test:443", "[::1]:1234", "source"},
		{"CONNECT", "other.test:443", "10.200.1.2:1234", "not_allowed"},
		{"CONNECT", "169.254.169.254:443", "10.200.1.2:1234", "not_allowed"},
		{"CONNECT", "rebind.test:443", "10.200.1.2:1234", "private_address"},
	} {
		r := proxyRequest(t, tc.method, tc.target, tc.source)
		response := httptest.NewRecorder()
		p.ServeHTTP(response, r)
		last := events[len(events)-1]
		if response.Code != 403 || last.Reason != tc.reason {
			t.Errorf("%s %s from %s: status %d, event %+v", tc.method, tc.target, tc.source, response.Code, last)
		}
		if (tc.reason == "not_connect" || tc.reason == "bad_target") && last.Target != nil {
			t.Errorf("logged target from %q", tc.target)
		}
	}
	if len(dialled) != 0 {
		t.Fatalf("refused requests dialled %v", dialled)
	}
	r := proxyRequest(t, "CONNECT", "ALLOWED.test:443", "[::ffff:10.200.1.2]:1234")
	// The recorder cannot hijack. The attempted dial is still observable.
	p.ServeHTTP(httptest.NewRecorder(), r)
	if allowedLookups != 1 || len(dialled) != 1 || dialled[0] != "tcp 203.0.113.10:443" {
		t.Fatalf("allowed lookups %d, dialled %v", allowedLookups, dialled)
	}
	if p.total != 0 || len(p.open) != 0 {
		t.Fatal("failed handshake leaked a slot")
	}

	if err := os.Remove(policy); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	p.ServeHTTP(response, r)
	if response.Code != 403 || events[len(events)-1].Reason != "no_policy" || len(dialled) != 1 {
		t.Fatal("removed policy still authorized a dial")
	}
}

func proxyRequest(t *testing.T, method, target, source string) *http.Request {
	t.Helper()
	r, err := http.ReadRequest(bufio.NewReader(strings.NewReader(method + " " + target + " HTTP/1.1\r\nHost: ignored.test\r\n\r\n")))
	if err != nil {
		t.Fatal(err)
	}
	r.RemoteAddr = source
	return r
}

func TestTunnelLimits(t *testing.T) {
	p := proxy{open: make(map[string]int)}
	for range perGuest {
		if reason := p.acquire("guest"); reason != "" {
			t.Fatal(reason)
		}
	}
	if reason := p.acquire("guest"); reason != "too_many" {
		t.Fatalf("guest limit: %q", reason)
	}
	p.total = totalTunnels
	if reason := p.acquire("another"); reason != "host_busy" {
		t.Fatalf("host limit: %q", reason)
	}
	p.release("guest")
	if reason := p.acquire("guest"); reason != "" {
		t.Fatalf("slot not released: %q", reason)
	}
}

func TestTunnelHalfClose(t *testing.T) {
	local, peer := net.Pipe()
	defer peer.Close()
	if err := peer.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	upstream := &halfCloseRecorder{data: make(chan string, 1)}
	done := make(chan struct{})
	go func() {
		defer close(done)
		tunnel(local, strings.NewReader("buffered hello"), upstream)
	}()
	if got, err := io.ReadAll(peer); err != nil || string(got) != "response" {
		t.Fatalf("reply after upstream half-close: %q, %v", got, err)
	}
	<-done
	if got := <-upstream.data; got != "buffered hello" {
		t.Fatalf("forwarded %q", got)
	}
}

type halfCloseRecorder struct {
	net.Conn
	strings.Builder
	data chan string
	sent bool
}

func (c *halfCloseRecorder) Write(b []byte) (int, error) { return c.Builder.Write(b) }
func (c *halfCloseRecorder) Read(b []byte) (int, error) {
	if c.sent {
		return 0, io.EOF
	}
	c.sent = true
	// The fake server replies only after the request side reaches EOF.
	forwarded := <-c.data
	c.data <- forwarded
	return copy(b, "response"), nil
}
func (c *halfCloseRecorder) CloseWrite() error { c.data <- c.String(); return nil }
func (c *halfCloseRecorder) Close() error      { return nil }
