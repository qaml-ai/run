//go:build linux && kvm

package computehost

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// TestKVMColdSessionBench measures create → first exec for a session whose branch tree is S MB, on a host that has
// never seen the lineage (cold: fresh data dir, empty cache and refs.db, objects only in CAMELFSD_KVM_STORE), then a
// second session of the same tree on the same host (warm). Each tree is 10k × 4 KiB files plus 1 MiB files up to S.
//
//	CAMELFSD_KVM=1 CAMELFSD_KVM_COLD_MB=50,500,2000 CAMELFSD_KVM_STORE=s3://bucket/prefix GUEST_IMAGE=… go test -tags kvm
func TestKVMColdSessionBench(t *testing.T) {
	if os.Getenv("CAMELFSD_KVM") != "1" || os.Getenv("CAMELFSD_KVM_COLD_MB") == "" {
		t.Skip("set CAMELFSD_KVM=1 and CAMELFSD_KVM_COLD_MB on the KVM lane")
	}
	url, guestImage := os.Getenv("CAMELFSD_KVM_STORE"), os.Getenv("GUEST_IMAGE")
	if !strings.HasPrefix(url, "s3://") || guestImage == "" {
		t.Fatal("CAMELFSD_KVM_STORE (s3://…) and GUEST_IMAGE are required")
	}
	for _, field := range strings.Split(os.Getenv("CAMELFSD_KVM_COLD_MB"), ",") {
		mb, err := strconv.Atoi(field)
		if err != nil || mb < 41 {
			t.Fatalf("size %q: want an integer above 40 (MB)", field)
		}
		t.Run(fmt.Sprintf("%dMB", mb), func(t *testing.T) { coldSession(t, url, guestImage, mb) })
	}
}

func coldSession(t *testing.T, url, guestImage string, mb int) {
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	ctx := t.Context()
	parent := os.Getenv("CAMELFSD_KVM_WORK")
	if parent == "" {
		parent = filepath.Dir(guestImage)
	}
	lineage := fmt.Sprintf("coldbench-%d-%d", mb, time.Now().UnixNano())
	remote, err := store.Open(ctx, url, "us-west-2", 64)
	must(err)

	// Seed: upload the blobs and the tree from a separate data dir, as the tier would have.
	seed := t.TempDir()
	seedDB, err := refs.Open(filepath.Join(seed, "refs.db"))
	must(err)
	repo := &objects.Repository{DB: seedDB, Store: remote, TempDir: seed}
	files := map[string]objects.File{}
	var mu sync.Mutex
	var blobs []string // "<size> <path>"
	for i := range 10000 {
		blobs = append(blobs, fmt.Sprintf("4096 src/d%03d/f%05d.ts", i/100, i))
	}
	for i := 0; i < mb-40; i++ {
		blobs = append(blobs, fmt.Sprintf("%d assets/a%04d.bin", 1<<20, i))
	}
	start := time.Now()
	must(store.Parallel(ctx, 64, blobs, func(item string) error {
		sizeField, path, _ := strings.Cut(item, " ")
		size, _ := strconv.Atoi(sizeField)
		raw := make([]byte, size)
		if _, err := rand.Read(raw); err != nil {
			return err
		}
		sum := sha256.Sum256(raw)
		hash := hex.EncodeToString(sum[:])
		if _, err := repo.Upload(ctx, lineage, hash, int64(len(raw)), bytes.NewReader(raw)); err != nil {
			return err
		}
		mu.Lock()
		files[path] = objects.File{SHA256: hash}
		mu.Unlock()
		return nil
	}))
	tree, err := repo.Import(ctx, objects.Request{Lineage: lineage, Files: files})
	must(err)
	must(seedDB.Close())
	t.Logf("seed %d MB, %d files: %s, tree %s", mb, len(files), time.Since(start).Round(time.Millisecond), tree.Tree)

	// Hosts: fresh data dirs that share nothing with the seed (or each other) but the store and the identity.
	cert, tierPair := testIdentity(t)
	var pinnedPEM []byte
	for _, ca := range cert.ca.certs {
		pinnedPEM = append(pinnedPEM, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.Raw})...)
	}
	f, err := os.Open(guestImage)
	must(err)
	hash := sha256.New()
	size, err := io.Copy(hash, f)
	must(err)
	must(f.Close())
	sha := hex.EncodeToString(hash.Sum(nil))
	shape := hostwire.Shape{VCPUs: 2, MemoryMiB: 2048, DiskMiB: int(max(1024, (size+(1<<20)-1)>>20))}
	kernel := os.Getenv("GUEST_KERNEL")
	if kernel == "" {
		kernel = "/var/lib/camel/guest/vmlinux"
	}
	ended := make(chan string, 8)
	tier := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := strings.TrimPrefix(r.URL.Path, "/v1/hosts/"+cert.HostID)
		switch {
		case route == "/register":
			jsonReply(w, 200, hostwire.Registered{BootEpoch: 9})
		case route == "/heartbeat":
			jsonReply(w, 200, hostwire.HeartbeatReply{BootEpoch: 9})
		case strings.HasSuffix(route, "/started"):
			w.WriteHeader(204)
		case strings.HasSuffix(route, "/ended"):
			ended <- route
			w.WriteHeader(204)
		case route == "/lineages/"+lineage+"/refs/main/cas":
			var q struct{ Commit string }
			if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			raw, err := store.ForLineage(remote, lineage).Get(r.Context(), "k/"+q.Commit)
			if err != nil {
				t.Errorf("checkpoint commit: %v", err)
				w.WriteHeader(500)
				return
			}
			jsonReply(w, 200, hostwire.CheckpointReply{Version: q.Commit, Tree: strings.Fields(string(raw))[1], Diff: json.RawMessage("[]")})
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
	client := &http.Client{Timeout: 10 * time.Minute, Transport: &http.Transport{DisableKeepAlives: true, TLSClientConfig: tierClientTLS(cert, tierPair)}}

	type host struct {
		endpoint, log string
		stop          func()
	}
	startHost := func() host {
		t.Helper()
		data, err := os.MkdirTemp(parent, "cold-session-")
		must(err)
		t.Cleanup(func() {
			if !t.Failed() && os.Getenv("CAMELFSD_KVM_KEEP") != "1" {
				os.RemoveAll(data)
			}
		})
		must(os.WriteFile(filepath.Join(data, "tier-ca.pem"), pinnedPEM, 0600))
		for _, name := range []string{"host-key.pem", "host-certificate.json"} {
			raw, err := os.ReadFile(filepath.Join(cert.dir, name))
			must(err)
			must(os.WriteFile(filepath.Join(data, name), raw, 0600))
		}
		must(os.MkdirAll(filepath.Join(data, "images"), 0700))
		must(exec.Command("cp", "--reflink=always", guestImage, filepath.Join(data, "images", sha+".ext4")).Run())
		cfg := kvmDaemonConfig{Data: data, Tier: strings.TrimPrefix(tier.URL, "https://"), HostID: cert.HostID, Kernel: kernel, Shape: shape,
			Store: url, VirtualSize: int64(mb+1024) << 20}
		config, err := json.Marshal(cfg)
		must(err)
		daemon := exec.Command(os.Args[0], "-test.run=^TestKVMComputeDaemonProcess$")
		daemon.Env = append(os.Environ(), "CAMELFSD_KVM_DAEMON="+string(config))
		stdout, err := daemon.StdoutPipe()
		must(err)
		logPath := filepath.Join(data, "daemon.log")
		log, err := os.OpenFile(logPath, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0600)
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
		case addr := <-ready:
			return host{addr, logPath, stop}
		case <-time.After(time.Minute):
			t.Fatal("daemon did not start")
		}
		return host{}
	}
	call := func(h host, method, path string, q any, status int) []byte {
		t.Helper()
		payload, err := json.Marshal(q)
		must(err)
		req, err := http.NewRequest(method, "https://"+h.endpoint+path, bytes.NewReader(payload))
		must(err)
		resp, err := client.Do(req)
		must(err)
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		must(err)
		if resp.StatusCode != status {
			t.Fatalf("%s %s: HTTP %d, want %d: %s", method, path, resp.StatusCode, status, raw)
		}
		return raw
	}
	// waitLog waits for a daemon log line containing every needle (the background baseline publication).
	waitLog := func(h host, needles ...string) string {
		t.Helper()
		deadline := time.Now().Add(10 * time.Minute)
		for time.Now().Before(deadline) {
			raw, _ := os.ReadFile(h.log)
			for _, line := range strings.Split(string(raw), "\n") {
				all := true
				for _, n := range needles {
					all = all && strings.Contains(line, n)
				}
				if all {
					return line
				}
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatalf("no log line with %q", needles)
		return ""
	}
	session := func(h host, id, at, version string, checkpoint bool) (time.Duration, string, string) {
		t.Helper()
		spec := hostwire.BootSpec{ID: id, Lineage: lineage, Ref: "main", Version: version, Parent: version, Tree: at,
			Image: sha, Shape: shape, Session: &hostwire.Session{IdleStopS: 3600},
			Lease: hostwire.Lease{Holder: hostwire.Holder{Host: cert.HostID, Boot: 9, Mount: id}, Epoch: 1}}
		begin := time.Now()
		call(h, "POST", "/v1/vms", spec, 202)
		var shell hostwire.ShellCreated
		for {
			payload, _ := json.Marshal(hostwire.ShellRequest{})
			req, _ := http.NewRequest("POST", "https://"+h.endpoint+"/v1/vms/"+id+"/shells", bytes.NewReader(payload))
			resp, err := client.Do(req)
			must(err)
			raw, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode == 201 {
				must(json.Unmarshal(raw, &shell))
				break
			}
			if resp.StatusCode != 409 || time.Since(begin) > 10*time.Minute {
				t.Fatalf("shell: HTTP %d %s", resp.StatusCode, raw)
			}
			time.Sleep(20 * time.Millisecond)
		}
		out := call(h, "POST", "/v1/vms/"+id+"/exec", hostwire.ExecRequest{ExecID: "first", Shell: shell.ShellID,
			Command: "find /workspace -type f | wc -l; du -sm /workspace | cut -f1", TimeoutS: 120}, 200)
		elapsed := time.Since(begin)
		assertOutput(t, out, strconv.Itoa(len(files)))
		next, nextVersion := at, version
		if checkpoint {
			call(h, "POST", "/v1/vms/"+id+"/exec", hostwire.ExecRequest{ExecID: "edit", Shell: shell.ShellID, Command: "echo edit >> /workspace/src/d000/f00000.ts", TimeoutS: 20}, 200)
			var reply hostwire.CheckpointReply
			must(json.Unmarshal(call(h, "POST", "/v1/vms/"+id+"/checkpoint", hostwire.CheckpointRequest{Message: "bench"}, 200), &reply))
			if !reply.Changed {
				t.Fatalf("checkpoint did not change: %+v", reply)
			}
			next, nextVersion = reply.Tree, reply.Version
		}
		call(h, "POST", "/v1/vms/"+id+"/stop", hostwire.Stop{Checkpoint: false}, 202)
		select {
		case <-ended:
		case <-time.After(2 * time.Minute):
			t.Fatal("ended callback missing")
		}
		return elapsed, next, nextVersion
	}
	base := strings.Repeat("a", 40)
	a := startHost()
	first, _, _ := session(a, "first-1", tree.Tree, base, false)
	baseline := waitLog(a, "compute_baseline", "vm=first-1")
	again, edited, editedVersion := session(a, "again-2", tree.Tree, base, true)
	resumed, _, _ := session(a, "resume-3", edited, editedVersion, false)
	a.stop()
	b := startHost()
	cross, _, _ := session(b, "cross-1", tree.Tree, base, false)
	for _, h := range []host{a, b} {
		raw, err := os.ReadFile(h.log)
		must(err)
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.Contains(line, "compute_boot") || strings.Contains(line, "compute_checkpoint") || strings.Contains(line, "compute_baseline") {
				t.Log(line)
			}
		}
	}
	t.Logf("baseline: %s", baseline)
	t.Logf("RESULT size_mb=%d files=%d first_ever_ms=%d same_host_same_tree_ms=%d same_host_checkpointed_ms=%d new_host_shared_root_ms=%d",
		mb, len(files), first.Milliseconds(), again.Milliseconds(), resumed.Milliseconds(), cross.Milliseconds())
}
