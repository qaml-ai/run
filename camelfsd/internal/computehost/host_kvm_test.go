//go:build linux && kvm

package computehost

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/vmhost"
)

func TestKVMComputeSessionRestart(t *testing.T) {
	if os.Getenv("CAMELFSD_KVM") != "1" {
		t.Skip("set CAMELFSD_KVM=1 on the KVM lane")
	}
	guestImage := os.Getenv("GUEST_IMAGE")
	if guestImage == "" {
		t.Fatal("GUEST_IMAGE must contain the current session guest")
	}
	parent := os.Getenv("CAMELFSD_KVM_WORK")
	if parent == "" {
		parent = filepath.Dir(guestImage)
	}
	data, err := os.MkdirTemp(parent, "host-session-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if !t.Failed() && os.Getenv("CAMELFSD_KVM_KEEP") != "1" {
			os.RemoveAll(data)
		} else {
			t.Logf("host files in %s", data)
		}
	})
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	cert, tierPair := testIdentity(t)
	var pinnedPEM []byte
	for _, ca := range cert.ca.certs {
		pinnedPEM = append(pinnedPEM, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.Raw})...)
	}
	must(os.WriteFile(filepath.Join(data, "tier-ca.pem"), pinnedPEM, 0600))
	// Share the same test CA and host credentials across both daemon processes.
	raw, err := os.ReadFile(filepath.Join(cert.dir, "host-key.pem"))
	must(err)
	must(os.WriteFile(filepath.Join(data, "host-key.pem"), raw, 0600))
	raw, err = os.ReadFile(filepath.Join(cert.dir, "host-certificate.json"))
	must(err)
	must(os.WriteFile(filepath.Join(data, "host-certificate.json"), raw, 0600))

	kernel := os.Getenv("GUEST_KERNEL")
	if kernel == "" {
		kernel = "/var/lib/camel/guest/vmlinux"
	}
	makeLauncher := func() *vmhost.Launcher {
		return &vmhost.Launcher{
			Firecracker: "/usr/local/bin/firecracker", Jailer: "/usr/local/bin/jailer", Kernel: kernel, Initrd: os.Getenv("GUEST_INITRD"),
			Work: filepath.Join(data, "compute"), PolicyDir: filepath.Join(data, "policy"), KVM: true, Reflink: "always",
		}
	}
	id := filepath.Base(data)
	t.Cleanup(func() {
		if err := makeLauncher().Destroy(context.Background(), id); err != nil {
			t.Error(err)
		}
	})
	f, err := os.Open(guestImage)
	must(err)
	hash := sha256.New()
	size, err := io.Copy(hash, f)
	must(err)
	must(f.Close())
	sha := hex.EncodeToString(hash.Sum(nil))
	must(os.MkdirAll(filepath.Join(data, "images"), 0700))
	// Seed the verified-image cache via an independent reflink. Open hashes it.
	must(exec.Command("cp", "--reflink=always", guestImage, filepath.Join(data, "images", sha+".ext4")).Run())
	shape := hostwire.Shape{VCPUs: 1, MemoryMiB: 1024, DiskMiB: int(max(1024, (size+(1<<20)-1)>>20))}
	local := store.Local{Dir: filepath.Join(data, "objects")}
	db, err := refs.Open(filepath.Join(data, "refs.db"))
	must(err)
	objs := &objects.Repository{DB: db, Store: local, TempDir: data}
	tree, err := objs.Import(t.Context(), objects.Request{Lineage: "lane", Files: map[string]objects.File{}})
	must(err)
	must(db.Close())
	spec := hostwire.BootSpec{ID: id, Lineage: "lane", Ref: "main", Version: strings.Repeat("a", 40), Parent: strings.Repeat("a", 40), Tree: tree.Tree, Image: sha,
		Shape: shape, Session: &hostwire.Session{IdleStopS: 3600}, Lease: hostwire.Lease{Holder: hostwire.Holder{Host: cert.HostID, Boot: 9, Mount: id}, Epoch: 1}}
	beats := make(chan hostwire.Heartbeat, 64)
	ended := make(chan hostwire.Ended, 8)
	tier := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		decode := func(out any) bool {
			if err := json.NewDecoder(r.Body).Decode(out); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return false
			}
			return true
		}
		switch strings.TrimPrefix(r.URL.Path, "/v1/hosts/"+cert.HostID) {
		case "/register":
			jsonReply(w, 200, hostwire.Registered{BootEpoch: 9})
		case "/heartbeat":
			var q hostwire.Heartbeat
			if !decode(&q) {
				return
			}
			select {
			case beats <- q:
			default:
			}
			jsonReply(w, 200, hostwire.HeartbeatReply{BootEpoch: 9})
		case "/vms/" + id + "/started":
			w.WriteHeader(204)
		case "/vms/" + id + "/ended":
			var q hostwire.Ended
			if !decode(&q) {
				return
			}
			ended <- q
			w.WriteHeader(204)
		case "/lineages/lane/refs/main/cas":
			var q struct{ Commit, Root string }
			if !decode(&q) {
				return
			}
			raw, err := store.ForLineage(local, "lane").Get(r.Context(), "k/"+q.Commit)
			if err != nil || !bytes.Contains(raw, []byte("Camel-Op: turn")) {
				t.Errorf("checkpoint commit missing: %v", err)
				w.WriteHeader(500)
				return
			}
			checkpointTree := strings.Fields(string(raw))[1]
			jsonReply(w, 200, hostwire.CheckpointReply{Version: q.Commit, Tree: checkpointTree, Diff: json.RawMessage("[]")})
		default:
			t.Errorf("unexpected tier route %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	tier.TLS = cert.current.Load().server.Clone()
	tier.TLS.Certificates[0] = tierPair
	tier.TLS.VerifyConnection = nil
	tier.StartTLS()
	t.Cleanup(tier.Close)

	cfg := kvmDaemonConfig{Data: data, Tier: strings.TrimPrefix(tier.URL, "https://"), HostID: cert.HostID, Kernel: kernel, Shape: shape}
	var endpoint string
	start := func() (func(), string) {
		t.Helper()
		config, err := json.Marshal(cfg)
		must(err)
		daemon := exec.Command(os.Args[0], "-test.run=^TestKVMComputeDaemonProcess$")
		daemon.Env = append(os.Environ(), "CAMELFSD_KVM_DAEMON="+string(config))
		stdout, err := daemon.StdoutPipe()
		must(err)
		log, err := os.OpenFile(filepath.Join(data, "daemon.log"), os.O_CREATE|os.O_RDWR|os.O_APPEND, 0600)
		must(err)
		daemon.Stderr = log
		must(daemon.Start())
		stop := func() { _ = daemon.Process.Kill(); _ = daemon.Wait(); log.Close() }
		t.Cleanup(stop)
		ready := make(chan string, 1)
		go func() {
			scan := bufio.NewScanner(stdout)
			for scan.Scan() {
				if addr, ok := strings.CutPrefix(scan.Text(), "ADDR "); ok {
					ready <- addr
				}
			}
		}()
		select {
		case endpoint = <-ready:
		case <-time.After(time.Minute):
			t.Fatal("daemon did not start")
		}
		return stop, endpoint
	}
	stop, endpoint := start()
	client := &http.Client{Timeout: 40 * time.Second, Transport: &http.Transport{DisableKeepAlives: true, TLSClientConfig: tierClientTLS(cert, tierPair)}}
	send := func(method, path string, q any) *http.Response {
		t.Helper()
		payload, err := json.Marshal(q)
		must(err)
		req, err := http.NewRequest(method, "https://"+endpoint+path, bytes.NewReader(payload))
		must(err)
		resp, err := client.Do(req)
		must(err)
		return resp
	}
	read := func(resp *http.Response, status int) []byte {
		t.Helper()
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		must(err)
		if resp.StatusCode != status {
			t.Fatalf("HTTP %d, want %d: %s", resp.StatusCode, status, raw)
		}
		return raw
	}
	waitListed := func() {
		t.Helper()
		timeout := time.After(45 * time.Second)
		for {
			select {
			case hb := <-beats:
				for _, v := range hb.Running {
					if v.ID == id && v.StartedAt != nil && !v.Finished {
						return
					}
				}
			case <-timeout:
				t.Fatal("VM was not listed as started")
			}
		}
	}
	path := "/v1/vms/" + id
	read(send("POST", "/v1/vms", spec), 202)
	waitListed()
	var shell hostwire.ShellCreated
	must(json.Unmarshal(read(send("POST", path+"/shells", hostwire.ShellRequest{}), 201), &shell))
	output := read(send("POST", path+"/exec", hostwire.ExecRequest{ExecID: "write", Shell: shell.ShellID, Command: "pwd; echo payload > proof", TimeoutS: 10}), 200)
	assertOutput(t, output, "/workspace")
	var changed, unchanged hostwire.CheckpointReply
	must(json.Unmarshal(read(send("POST", path+"/checkpoint", hostwire.CheckpointRequest{Message: "test"}), 200), &changed))
	must(json.Unmarshal(read(send("POST", path+"/checkpoint", hostwire.CheckpointRequest{}), 200), &unchanged))
	if !changed.Changed || unchanged.Changed || changed.Version != unchanged.Version {
		t.Fatalf("checkpoint results: %+v %+v", changed, unchanged)
	}
	resp := send("POST", path+"/exec", hostwire.ExecRequest{ExecID: "resume", Shell: shell.ShellID, Command: "echo before; sleep 8; echo after", TimeoutS: 20})
	reader := bufio.NewReader(resp.Body)
	for {
		line, err := reader.ReadString('\n')
		must(err)
		if strings.Contains(line, base64.StdEncoding.EncodeToString([]byte("before\n"))) {
			break
		}
	}
	stop()
	resp.Body.Close()
	for len(beats) > 0 {
		<-beats
	}
	_, endpoint = start()
	waitListed()
	output = read(send("GET", path+"/exec/resume?offset=0", nil), 200)
	assertOutput(t, output, "after")
	read(send("POST", path+"/stop", hostwire.Stop{Checkpoint: false}), 202)
	select {
	case result := <-ended:
		if result.Code != "stopped" || result.Version != changed.Version {
			t.Fatalf("ended: %+v", result)
		}
	case <-time.After(45 * time.Second):
		t.Fatal("ended callback missing")
	}
	raw, err = os.ReadFile(filepath.Join(data, "daemon.log"))
	must(err)
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.Contains(line, "msg=compute_boot") || strings.Contains(line, "msg=compute_checkpoint") {
			t.Log(line)
		}
	}
}

func tierClientTLS(host *Identity, tier tls.Certificate) *tls.Config {
	return &tls.Config{Certificates: []tls.Certificate{tier}, InsecureSkipVerify: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			return verifyPeer(cs.PeerCertificates[0], nil, host.current.Load().server.ClientCAs, x509.ExtKeyUsageServerAuth)
		},
	}
}

func assertOutput(t *testing.T, response []byte, want string) {
	t.Helper()
	var out bytes.Buffer
	for _, line := range bytes.Split(response, []byte("\n")) {
		if raw, ok := bytes.CutPrefix(line, []byte("data: ")); ok {
			var chunk hostwire.ExecChunk
			if err := json.Unmarshal(raw, &chunk); err != nil {
				t.Fatal(err)
			}
			out.Write(chunk.Data)
		}
	}
	if !strings.Contains(out.String(), want) || !bytes.Contains(response, []byte("event: exit")) {
		t.Fatalf("wanted %q and exit: %s", want, response)
	}
}

type kvmDaemonConfig struct {
	Data, Tier, HostID, Kernel string
	Shape                      hostwire.Shape
}

func TestKVMComputeDaemonProcess(t *testing.T) {
	raw := os.Getenv("CAMELFSD_KVM_DAEMON")
	if raw == "" {
		t.Skip("subprocess helper")
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	var q kvmDaemonConfig
	must(json.Unmarshal([]byte(raw), &q))
	ctx := t.Context()
	local := store.Local{Dir: filepath.Join(q.Data, "objects")}
	db, err := refs.Open(filepath.Join(q.Data, "refs.db"))
	must(err)
	defer db.Close()
	m, err := image.New(image.Config{Data: q.Data, RecoverSessions: true, VirtualSize: 32 << 20}, local, cache.New(filepath.Join(q.Data, "cache"), local, 4), db)
	must(err)
	defer m.Close()
	// Enrollment is already persisted by the harness.
	pinned, err := LoadTierCA(filepath.Join(q.Data, "tier-ca.pem"))
	must(err)
	cert, err := NewIdentity(ctx, q.Data, q.HostID, "test", q.Tier, "https://unused.test", pinned, nil)
	must(err)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	launcher := &vmhost.Launcher{Firecracker: "/usr/local/bin/firecracker", Jailer: "/usr/local/bin/jailer", Kernel: q.Kernel, Initrd: os.Getenv("GUEST_INITRD"),
		Work: filepath.Join(q.Data, "compute"), PolicyDir: filepath.Join(q.Data, "policy"), KVM: true, Reflink: "always"}
	host, err := Open(ctx, Config{Data: q.Data, BootID: "fixture-boot", HostID: q.HostID, Pool: "test", Addr: listener.Addr().String(),
		Shape: q.Shape, Slots: 1, Mounts: m, Launcher: launcher, Post: cert.Post})
	must(err)
	defer host.Close()
	must(host.Recover(ctx))
	go host.Run(ctx)
	server := &http.Server{Handler: host.Handler(), TLSConfig: cert.ServerTLS()}
	fmt.Println("ADDR", listener.Addr())
	must(server.Serve(tls.NewListener(listener, cert.ServerTLS())))
}
