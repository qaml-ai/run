// Package egress serves the job host's HTTPS CONNECT proxy.
package egress

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/vmhost"
)

const (
	connectTimeout = 10 * time.Second
	tunnelIdle     = 5 * time.Minute
	perGuest       = 256
	totalTunnels   = 4096
)

var (
	authority = regexp.MustCompile(`^([A-Za-z0-9.-]{1,253}):([0-9]{1,5})$`)
	hostname  = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
)

func allowed(host string, rules []string) bool {
	name := strings.ToLower(host)
	if len(name) > 253 || !hostname.MatchString(name) {
		return false
	}
	for _, entry := range rules {
		rule := strings.ToLower(entry)
		if suffix, wildcard := strings.CutPrefix(rule, "*"); wildcard && strings.HasPrefix(suffix, ".") {
			if len(name) > len(suffix) && strings.HasSuffix(name, suffix) {
				return true
			}
		} else if name == rule {
			return true
		}
	}
	return false
}

// Keep the TypeScript proxy’s address exclusions, using binary prefixes
// so alternate spellings of the same IPv6 address are treated alike.
var reserved = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/16"), netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("224.0.0.0/3"),
	// IPv4-compatible (::/96, which covers :: and ::1), mapped, 6to4 and Teredo addresses can all carry a private IPv4.
	netip.MustParsePrefix("::/96"), netip.MustParsePrefix("::ffff:0:0/96"),
	netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("2001::/32"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("64:ff9b::/32"), netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"), netip.MustParsePrefix("ff00::/8"),
}

func publicAddress(address netip.Addr) bool {
	if !address.IsValid() || address.Zone() != "" {
		return false
	}
	for _, prefix := range reserved {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

type event struct {
	Type   string  `json:"type"`
	Source string  `json:"source"`
	Target *string `json:"target"`
	Reason string  `json:"reason,omitempty"`
	Job    string  `json:"job,omitempty"`
}

type proxy struct {
	policyDir string
	lookup    func(context.Context, string) ([]netip.Addr, error)
	dial      func(context.Context, string, string) (net.Conn, error)
	log       func(event)

	mu    sync.Mutex
	open  map[string]int
	total int
}

// NewHandler constructs a proxy handler. The host firewall limits which
// interfaces and source addresses may reach the listener.
func NewHandler(policyDir string, logs io.Writer) http.Handler {
	encoder := json.NewEncoder(logs)
	var logMu sync.Mutex
	p := &proxy{
		policyDir: policyDir,
		lookup:    amazonLookup,
		dial:      (&net.Dialer{}).DialContext,
		log: func(e event) {
			logMu.Lock()
			defer logMu.Unlock()
			_ = encoder.Encode(e)
		},
		open: make(map[string]int),
	}
	return p
}

func (p *proxy) acquire(source string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.open[source] >= perGuest {
		return "too_many"
	}
	if p.total >= totalTunnels {
		return "host_busy"
	}
	p.open[source]++
	p.total++
	return ""
}

func (p *proxy) release(source string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.open[source]--
	p.total--
	if p.open[source] == 0 {
		delete(p.open, source)
	}
}

func (p *proxy) readPolicy(source netip.Addr) (vmhost.EgressPolicy, bool) {
	var policy vmhost.EgressPolicy
	if !source.Is4() {
		return policy, false
	}
	data, err := os.ReadFile(filepath.Join(p.policyDir, source.String()+".json"))
	if err != nil || json.Unmarshal(data, &policy) != nil || policy.Allow == nil {
		return policy, false
	}
	return policy, true
}

func (p *proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	source, _, _ := net.SplitHostPort(r.RemoteAddr)
	var target *string
	refuse := func(reason string) {
		p.log(event{Type: "egress_refused", Source: source, Target: target, Reason: reason})
		w.Header().Set("Connection", "close")
		w.WriteHeader(http.StatusForbidden)
	}
	if r.Method != http.MethodConnect {
		refuse("not_connect")
		return
	}
	match := authority.FindStringSubmatch(r.RequestURI)
	if match == nil {
		refuse("bad_target")
		return
	}
	host := strings.ToLower(match[1])
	normalized := host + ":" + match[2]
	target = &normalized
	if match[2] != "443" {
		refuse("port")
		return
	}
	ip, _ := netip.ParseAddr(source)
	ip = ip.Unmap()
	if !ip.Is4() {
		refuse("source")
		return
	}
	source = ip.String()
	policy, ok := p.readPolicy(ip)
	if !ok {
		refuse("no_policy")
		return
	}
	if !allowed(host, policy.Allow) {
		refuse("not_allowed")
		return
	}
	if reason := p.acquire(source); reason != "" {
		refuse(reason)
		return
	}
	defer p.release(source)

	ctx, cancel := context.WithTimeout(r.Context(), connectTimeout)
	defer cancel()
	addresses, err := p.lookup(ctx, host)
	if err != nil || len(addresses) == 0 {
		refuse("unresolved")
		return
	}
	for _, address := range addresses {
		if !publicAddress(address) {
			refuse("private_address")
			return
		}
	}
	upstream, err := p.dial(ctx, "tcp", netip.AddrPortFrom(addresses[0], 443).String())
	if err != nil {
		refuse("dial_failed")
		return
	}
	defer upstream.Close()
	client, buffered, err := http.NewResponseController(w).Hijack()
	if err != nil {
		refuse("error")
		return
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(connectTimeout))
	if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	if err := buffered.Flush(); err != nil {
		return
	}
	_ = client.SetDeadline(time.Time{})
	p.log(event{Type: "egress_open", Source: source, Target: target, Job: policy.Job})
	tunnel(client, buffered.Reader, upstream)
}

type activityReader struct {
	io.Reader
	timer *time.Timer
}

func (r activityReader) Read(b []byte) (int, error) {
	n, err := r.Reader.Read(b)
	if n > 0 {
		r.timer.Reset(tunnelIdle)
	}
	return n, err
}

func tunnel(client net.Conn, buffered io.Reader, upstream net.Conn) {
	closeBoth := func() {
		client.Close()
		upstream.Close()
	}
	idle := time.AfterFunc(tunnelIdle, closeBoth)
	defer idle.Stop()

	copyHalf := func(dst net.Conn, src io.Reader) {
		_, err := io.Copy(dst, activityReader{src, idle})
		if half, ok := dst.(interface{ CloseWrite() error }); err == nil && ok {
			err = half.CloseWrite()
			if err == nil {
				return
			}
		}
		closeBoth()
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		copyHalf(upstream, buffered)
	}()
	copyHalf(client, upstream)
	<-done
}
