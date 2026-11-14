package egress

import (
	"context"
	"net/netip"
	"testing"

	"golang.org/x/net/dns/dnsmessage"
)

// fakeExchange answers each family with a fixed rcode and addresses, or a transport error.
func fakeExchange(t *testing.T, a, aaaa func(dnsmessage.Message) (dnsmessage.Message, error)) {
	t.Helper()
	old := exchange
	t.Cleanup(func() { exchange = old })
	exchange = func(_ context.Context, q dnsmessage.Message, _ []byte) (dnsmessage.Message, error) {
		if q.Questions[0].Type == dnsmessage.TypeA {
			return a(q)
		}
		return aaaa(q)
	}
}

func reply(code dnsmessage.RCode, addrs ...netip.Addr) func(dnsmessage.Message) (dnsmessage.Message, error) {
	return func(q dnsmessage.Message) (dnsmessage.Message, error) {
		m := dnsmessage.Message{Header: dnsmessage.Header{ID: q.Header.ID, Response: true, RCode: code}, Questions: q.Questions}
		for _, addr := range addrs {
			h := dnsmessage.ResourceHeader{Name: q.Questions[0].Name, Class: dnsmessage.ClassINET, TTL: 60}
			if addr.Is4() {
				h.Type = dnsmessage.TypeA
				m.Answers = append(m.Answers, dnsmessage.Resource{Header: h, Body: &dnsmessage.AResource{A: addr.As4()}})
			} else {
				h.Type = dnsmessage.TypeAAAA
				m.Answers = append(m.Answers, dnsmessage.Resource{Header: h, Body: &dnsmessage.AAAAResource{AAAA: addr.As16()}})
			}
		}
		return m, nil
	}
}

func timeout(dnsmessage.Message) (dnsmessage.Message, error) {
	return dnsmessage.Message{}, context.DeadlineExceeded
}

func TestLookupFamilies(t *testing.T) {
	v4 := netip.MustParseAddr("140.82.112.3")
	for name, c := range map[string]struct {
		a, aaaa func(dnsmessage.Message) (dnsmessage.Message, error)
		want    int
		fails   bool
	}{
		"v4-only host, AAAA NODATA":   {reply(dnsmessage.RCodeSuccess, v4), reply(dnsmessage.RCodeSuccess), 1, false},
		"v4-only host, AAAA NXDOMAIN": {reply(dnsmessage.RCodeSuccess, v4), reply(dnsmessage.RCodeNameError), 1, false},
		"AAAA SERVFAIL fails":         {reply(dnsmessage.RCodeSuccess, v4), reply(dnsmessage.RCodeServerFailure), 0, true},
		"AAAA REFUSED fails":          {reply(dnsmessage.RCodeSuccess, v4), reply(dnsmessage.RCodeRefused), 0, true},
		"AAAA timeout fails":          {reply(dnsmessage.RCodeSuccess, v4), timeout, 0, true},
		"A timeout fails":             {timeout, reply(dnsmessage.RCodeSuccess), 0, true},
		"both NXDOMAIN: no addresses": {reply(dnsmessage.RCodeNameError), reply(dnsmessage.RCodeNameError), 0, false},
	} {
		t.Run(name, func(t *testing.T) {
			fakeExchange(t, c.a, c.aaaa)
			addrs, err := amazonLookup(t.Context(), "example.com")
			// A failed family is an error whatever the other family returned: the proxy refuses on any error.
			if (err != nil) != c.fails || (!c.fails && len(addrs) != c.want) {
				t.Fatalf("addrs %v err %v, want %d addresses, fails=%v", addrs, err, c.want, c.fails)
			}
		})
	}
}
