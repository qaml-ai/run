package egress

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

const amazonDNS = "169.254.169.253:53"

func amazonLookup(ctx context.Context, host string) ([]netip.Addr, error) {
	name, err := dnsmessage.NewName(host + ".")
	if err != nil {
		return nil, err
	}

	// Query both families. An empty successful result is fine, but a
	// failed query could hide a private address in the other family.
	var addresses [2][]netip.Addr
	var lookupErr [2]error
	done := make(chan struct{})
	go func() {
		addresses[0], lookupErr[0] = lookupFamily(ctx, name, dnsmessage.TypeA)
		close(done)
	}()
	addresses[1], lookupErr[1] = lookupFamily(ctx, name, dnsmessage.TypeAAAA)
	<-done
	return append(addresses[0], addresses[1]...), errors.Join(lookupErr[:]...)
}

func lookupFamily(ctx context.Context, name dnsmessage.Name, family dnsmessage.Type) ([]netip.Addr, error) {
	var id [2]byte
	if _, err := rand.Read(id[:]); err != nil {
		return nil, err
	}
	question := dnsmessage.Question{Name: name, Type: family, Class: dnsmessage.ClassINET}
	query := dnsmessage.Message{
		Header:    dnsmessage.Header{ID: binary.BigEndian.Uint16(id[:]), RecursionDesired: true},
		Questions: []dnsmessage.Question{question},
	}
	packet, err := query.Pack()
	if err != nil {
		return nil, err
	}
	var reply dnsmessage.Message
	for range 2 {
		attempt, cancel := context.WithTimeout(ctx, 3*time.Second)
		reply, err = exchangeDNS(attempt, query, packet)
		cancel()
		if err == nil {
			break
		}
	}
	if err != nil {
		return nil, err
	}
	if reply.RCode != dnsmessage.RCodeSuccess {
		return nil, fmt.Errorf("DNS response code %v", reply.RCode)
	}

	// Inspect all address answers, including answers for CNAME targets.
	// Keep AAAA bytes intact so a mapped address cannot become an A record.
	var addresses []netip.Addr
	for _, answer := range reply.Answers {
		switch body := answer.Body.(type) {
		case *dnsmessage.AResource:
			addresses = append(addresses, netip.AddrFrom4(body.A))
		case *dnsmessage.AAAAResource:
			addresses = append(addresses, netip.AddrFrom16(body.AAAA))
		}
	}
	return addresses, nil
}

func exchangeDNS(ctx context.Context, query dnsmessage.Message, packet []byte) (dnsmessage.Message, error) {
	var reply dnsmessage.Message
	for _, network := range []string{"udp", "tcp"} {
		data, err := dnsRoundTrip(ctx, network, packet)
		if err != nil {
			return reply, err
		}
		var parser dnsmessage.Parser
		header, err := parser.Start(data)
		if err != nil {
			return reply, err
		}
		question, err := parser.Question()
		if err != nil || !header.Response || header.ID != query.ID || question != query.Questions[0] {
			return reply, errors.New("unexpected DNS response")
		}
		if !header.Truncated {
			err := reply.Unpack(data)
			return reply, err
		}
	}
	return reply, errors.New("truncated DNS response")
}

func dnsRoundTrip(ctx context.Context, network string, packet []byte) ([]byte, error) {
	conn, err := (&net.Dialer{}).DialContext(ctx, network, amazonDNS)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	if network == "udp" {
		if _, err := conn.Write(packet); err != nil {
			return nil, err
		}
		reply := make([]byte, 512) // classic DNS without EDNS
		n, err := conn.Read(reply)
		return reply[:n], err
	}

	var size [2]byte
	binary.BigEndian.PutUint16(size[:], uint16(len(packet)))
	if _, err := conn.Write(append(size[:], packet...)); err != nil {
		return nil, err
	}
	if _, err := io.ReadFull(conn, size[:]); err != nil {
		return nil, err
	}
	reply := make([]byte, binary.BigEndian.Uint16(size[:]))
	_, err = io.ReadFull(conn, reply)
	return reply, err
}
