//go:build linux

package vmhost

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestJobAddress(t *testing.T) {
	for _, tc := range []struct {
		slot         int
		tap, ip, mac string
	}{
		{0, "cj0", "10.200.0.", "06:00:0a:c8:00:02"},
		{15, "cj15", "10.200.15.", "06:00:0a:c8:0f:02"},
		{249, "cj249", "10.200.249.", "06:00:0a:c8:f9:02"},
	} {
		a, err := JobAddress(tc.slot)
		if err != nil {
			t.Fatal(err)
		}
		if a.Slot != tc.slot || a.Tap != tc.tap || a.MAC != tc.mac || a.HostIP.String() != tc.ip+"1" ||
			a.GuestIP.String() != tc.ip+"2" || a.Prefix != 30 {
			t.Fatalf("unexpected address: %+v", a)
		}
		without := "camel.ip=" + tc.ip + "2/30 camel.gw=" + tc.ip + "1"
		if got := GuestNetArgs(a, false); got != without {
			t.Fatal(got)
		}
		if got := GuestNetArgs(a, true); got != without+" camel.proxy=http://"+tc.ip+"1:3128" {
			t.Fatal(got)
		}
	}
	for _, slot := range []int{-1, MaxSlots} {
		if _, err := JobAddress(slot); err == nil {
			t.Fatalf("accepted slot %d", slot)
		}
	}
}

func TestBaseRules(t *testing.T) {
	want, err := os.ReadFile("../../../infra/job-hosts/image/files/camel-host.nft")
	if err != nil {
		t.Fatal(err)
	}
	if BaseRules() != string(want) {
		t.Fatal("BaseRules differs from camel-host.nft")
	}
}

func TestFirecrackerConfig(t *testing.T) {
	addr, _ := JobAddress(10)
	for _, tc := range []struct {
		name, initrd, repo   string
		build, kvm, internet bool
	}{
		{"kvm", "", "", false, true, false},
		{"nitro-build", "/assets/initrd", "/assets/repo", true, false, true},
		{"nitro", "", "", false, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Fixture generated with jobhost/vm.ts and jobhost/network.ts.
			want, err := os.ReadFile(filepath.Join("testdata", tc.name+".json"))
			if err != nil {
				t.Fatal(err)
			}
			files := configFiles{kernel: "/assets/kernel", initrd: tc.initrd, disk: "/assets/root.ext4", repo: tc.repo, vsock: "guest.vsock"}
			got, err := json.Marshal(firecrackerConfig(files, addr, Shape{2, 1024, 8192}, tc.build, tc.kvm, tc.internet))
			if err != nil {
				t.Fatal(err)
			}
			var expected, actual any
			if err := json.Unmarshal(want, &expected); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(got, &actual); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(expected, actual) {
				t.Fatalf("got %s, want %s", got, want)
			}
		})
	}
}

func TestBootRejectsInvalidIDAndSmallDiskBeforeAllocating(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "base.ext4")
	if err := os.WriteFile(base, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(base, 2*mib+1); err != nil {
		t.Fatal(err)
	}
	l := Launcher{Image: base, Work: filepath.Join(dir, "work"), PolicyDir: filepath.Join(dir, "policies")}
	for _, id := range []string{"", "a/b", "😀", strings.Repeat("x", 97), "x\n"} {
		if _, err := l.Boot(t.Context(), id, Shape{1, 128, 3}, Boot{}); err == nil || err.Error() != "invalid job id" {
			t.Fatalf("boot for %q: %v", id, err)
		}
	}
	if _, err := l.Boot(t.Context(), "a-B_1.2", Shape{1, 128, 2}, Boot{}); err == nil ||
		err.Error() != "invalid_request: job disk 2 MiB is smaller than the base image 3 MiB" {
		t.Fatalf("boot: %v", err)
	}
	for _, id := range []string{".", "..", strings.Repeat("x", 96), "a-B_1.2"} {
		if _, err := l.validate(id, Shape{1, 128, 3}); err != nil {
			t.Fatal(err)
		}
		if filepath.Dir(l.jailPath(id)) != filepath.Join(l.Work, "jail") {
			t.Fatalf("jail escapes for %q", id)
		}
	}
	if _, err := os.Stat(l.Work); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("work dir was allocated: %v", err)
	}
}

func TestPolicy(t *testing.T) {
	l := Launcher{Egress: []string{"example.com"}, RuntimeHost: "run.camelai.com"}
	dir := t.TempDir()
	ip := netip.MustParseAddr("10.200.10.2")
	path := filepath.Join(dir, "10.200.10.2.json")
	for _, tc := range []struct {
		internet bool
		want     string
	}{
		{false, `{"job":"job-10","allow":[]}`},
		{true, `{"job":"job-10","allow":["example.com","run.camelai.com"]}`},
	} {
		if err := writePolicy(dir, ip, l.policy("job-10", tc.internet)); err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(path)
		if err != nil || string(b) != tc.want {
			t.Fatalf("policy: %s, %v", b, err)
		}
		st, err := os.Stat(path)
		if err != nil || st.Mode().Perm() != 0644 {
			t.Fatalf("policy mode: %v, %v", st, err)
		}
	}
	if err := removePolicy(dir, ip); err != nil {
		t.Fatal(err)
	}
	if err := removePolicy(dir, ip); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
}

func fakeVsock(t *testing.T, serve func(net.Conn) error) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "vmhost-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "guest.vsock")
	listen, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listen.Close() })
	done := make(chan error, 1)
	go func() {
		conn, err := listen.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(3 * time.Second))
		done <- serve(conn)
	}()
	t.Cleanup(func() {
		listen.Close()
		if err := <-done; err != nil && !errors.Is(err, net.ErrClosed) {
			t.Error(err)
		}
	})
	return path
}

func TestGuestHandshakeAndFraming(t *testing.T) {
	path := fakeVsock(t, func(conn net.Conn) error {
		in := bufio.NewReader(conn)
		connect, err := in.ReadString('\n')
		if err != nil || connect != "CONNECT 5000\n" {
			return fmt.Errorf("CONNECT: %q, %v", connect, err)
		}
		// The reply is buffered behind OK in the same write.
		if _, err := io.WriteString(conn, "OK 123\r\n{\"event\":\"log\",\"stream\":\"stdout\",\"data\":\"aGk=\"}\n"); err != nil {
			return err
		}
		req, err := in.ReadString('\n')
		if err != nil || req != "{\"op\":\"run\"}\n" {
			return fmt.Errorf("request: %q, %v", req, err)
		}
		_, err = io.WriteString(conn, "{\"ok\":true,\"exitCode\":0}\n")
		return err
	})
	c, err := connectGuest(t.Context(), path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.conn.Close()
	var logs []string
	reply, err := c.request(t.Context(), map[string]string{"op": "run"}, func(stream, data string) { logs = append(logs, stream+":"+data) })
	if err != nil || reply["ok"] != true || reply["exitCode"] != float64(0) ||
		!reflect.DeepEqual(logs, []string{"stdout:aGk="}) {
		t.Fatalf("reply/logs: %v %v %v", reply, logs, err)
	}
}

func TestGuestDeadline(t *testing.T) {
	path := fakeVsock(t, func(conn net.Conn) error {
		_, err := io.Copy(io.Discard, conn)
		return err
	})
	start := time.Now()
	_, err := connectGuest(t.Context(), path, 80*time.Millisecond)
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Fatalf("handshake deadline: %v (%s)", err, time.Since(start))
	}
}

func TestBoundedLine(t *testing.T) {
	for _, size := range []int{15, 16, 17, 33} {
		for _, suffix := range []string{"", "\n"} {
			line, err := boundedLine(bufio.NewReaderSize(strings.NewReader(strings.Repeat("x", size)+suffix), 16), 16)
			switch {
			case size > 16:
				if err == nil || !strings.Contains(err.Error(), "over 16 bytes") {
					t.Fatalf("size %d: %v", size, err)
				}
			case suffix == "":
				if !errors.Is(err, io.EOF) {
					t.Fatal(err)
				}
			default:
				if len(line) != size || err != nil {
					t.Fatalf("size %d: %q %v", size, line, err)
				}
			}
		}
	}
}
