//go:build linux && kvm

package computehost

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
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

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/qaml-ai/run/camelfsd/internal/api"
	"github.com/qaml-ai/run/camelfsd/internal/auth"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// TestKVMColdSessionBench measures create → first exec for a session whose branch tree is S MB, on a host that has
// never seen the lineage (cold: fresh data dir, empty cache and refs.db, objects only in CAMELFSD_KVM_STORE), then a
// second session of the same tree on the same host (warm). Each tree is 10k × 4 KiB files plus 1 MiB files up to S.
// CAMELFSD_KVM_OBJECTS_TABLE enables bundled writes for the small files and bundle reads on each host.
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
	t.Logf("benchmark lineage=%s", lineage)
	packedMode := os.Getenv("CAMELFSD_KVM_PACKED_APPLY")
	if packedMode != "" && packedMode != "control" && packedMode != "plain" && packedMode != "gzip" {
		t.Fatal("CAMELFSD_KVM_PACKED_APPLY must be control, plain or gzip")
	}
	packedParallel := os.Getenv("CAMELFSD_KVM_PACKED_PARALLEL") == "1"
	if packedParallel && packedMode != "plain" {
		t.Fatal("CAMELFSD_KVM_PACKED_PARALLEL requires CAMELFSD_KVM_PACKED_APPLY=plain")
	}
	content := os.Getenv("CAMELFSD_KVM_CONTENT")
	if content != "" && content != "random" && content != "source" {
		t.Fatal("CAMELFSD_KVM_CONTENT must be random or source")
	}
	t.Logf("benchmark content=%s", content)
	seedBytes := func(path string, size int) ([]byte, error) {
		if content == "source" && strings.HasPrefix(path, "src/") {
			text := []byte(fmt.Sprintf("// %s\nexport type Item = { id: string; active: boolean; tags: string[] };\nexport function activeItems(items: Item[]): Item[] {\n  return items.filter(item => item.active).map(item => ({ ...item, tags: [...item.tags].sort() }));\n}\n", path))
			return bytes.Repeat(text, (size+len(text)-1)/len(text))[:size], nil
		}
		raw := make([]byte, size)
		_, err := rand.Read(raw)
		return raw, err
	}
	objectsTable := os.Getenv("CAMELFSD_KVM_OBJECTS_TABLE")
	remote, err := openBenchmarkStore(ctx, url, objectsTable, 64)
	must(err)

	// Seed: upload the blobs and the tree from a separate data dir, as the tier would have.
	seed := t.TempDir()
	seedDB, err := refs.Open(filepath.Join(seed, "refs.db"))
	must(err)
	repo := &objects.Repository{DB: seedDB, Store: remote, TempDir: seed}
	files := map[string]objects.File{}
	start := time.Now()
	batch := repo.ForLineage(lineage).BeginPublication()
	smallIDs := make([]string, 0, 10000)
	var mu sync.Mutex
	var blobs []string // "<size> <path>"
	for i := range 10000 {
		path := fmt.Sprintf("src/d%03d/f%05d.ts", i/100, i)
		if objectsTable == "" {
			blobs = append(blobs, "4096 "+path)
			continue
		}
		raw, err := seedBytes(path, 4096)
		must(err)
		blob := batch.StageBlob(raw)
		sum := sha256.Sum256(raw)
		files[path] = objects.File{SHA256: hex.EncodeToString(sum[:])}
		smallIDs = append(smallIDs, blob.SHA1)
	}
	if objectsTable != "" {
		must(batch.Flush(ctx))
		locations, err := store.LocateBundles(ctx, store.ForLineage(remote, lineage), smallIDs)
		must(err)
		packs := make(map[string]bool)
		for _, location := range locations {
			packs[location.Key] = true
		}
		if len(locations) != len(smallIDs) || len(packs) >= len(smallIDs) {
			t.Fatalf("bundled %d of %d small blobs in %d packs", len(locations), len(smallIDs), len(packs))
		}
		t.Logf("seed bundles: %d blobs in %d packs", len(locations), len(packs))
	}
	for i := 0; i < mb-40; i++ {
		blobs = append(blobs, fmt.Sprintf("%d assets/a%04d.bin", 1<<20, i))
	}
	must(store.Parallel(ctx, 64, blobs, func(item string) error {
		sizeField, path, _ := strings.Cut(item, " ")
		size, _ := strconv.Atoi(sizeField)
		raw, err := seedBytes(path, size)
		if err != nil {
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

	cleanMode := os.Getenv("CAMELFSD_KVM_CLEAN_IMAGE") == "1"
	if cleanMode && packedMode != "control" {
		t.Fatal("clean-image mode requires CAMELFSD_KVM_PACKED_APPLY=control")
	}
	var cleanImage *portableImage
	var cleanKey string
	prepareClean := func(version, tree string) {
		t.Helper()
		if !cleanMode {
			return
		}
		artifactDir := t.TempDir()
		db, err := refs.OpenStorage(filepath.Join(artifactDir, "producer.db"))
		must(err)
		defer db.Close()
		producer := (&objects.Repository{DB: db, Store: remote, TempDir: artifactDir}).ForLineage(lineage)
		value, err := buildPortableImage(ctx, producer, store.ForLineage(remote, lineage), version, tree, artifactDir, int64(mb+1024)<<20)
		must(err)
		client, bucket, prefix := portableImageS3(t, url)
		cleanKey = uploadPortableImage(t, client, bucket, prefix, lineage, value)
		cleanImage = &value
	}
	type host struct {
		endpoint, log string
		restore       time.Duration
		stop          func()
	}
	var prepared *image.PackedApply
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
		var restore time.Duration
		if cleanImage != nil {
			start := time.Now()
			client, bucket, _ := portableImageS3(t, url)
			if os.Getenv("CAMELFSD_KVM_IMAGE_RANGES") == "1" {
				fetch := time.Now()
				spool, ranges, err := downloadPortableRanges(ctx, client, bucket, cleanKey, data, cleanImage.CompressedSize)
				must(err)
				fetchTime := time.Since(fetch)
				err = restorePortableImage(ctx, spool, *cleanImage, data, lineage)
				spool.Close()
				os.Remove(spool.Name())
				must(err)
				t.Logf("CLEAN_IMAGE_RANGE_FETCH ranges=%d ms=%d", ranges, fetchTime.Milliseconds())
			} else {
				reply, err := client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(bucket), Key: aws.String(cleanKey)})
				must(err)
				must(restorePortableImage(ctx, reply.Body, *cleanImage, data, lineage))
				must(reply.Body.Close())
			}
			restore = time.Since(start)
			t.Logf("CLEAN_IMAGE_RESTORE tree=%s compressed_bytes=%d transfer_restore_ms=%d", cleanImage.Tree, cleanImage.CompressedSize, restore.Milliseconds())
		}
		cfg := kvmDaemonConfig{Data: data, Tier: strings.TrimPrefix(tier.URL, "https://"), HostID: cert.HostID, Kernel: kernel, Shape: shape,
			Store: url, ObjectsTable: objectsTable, VirtualSize: int64(mb+1024) << 20, PackedApply: prepared, PackedParallel: packedParallel}
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
		stop := sync.OnceFunc(func() { _ = daemon.Process.Kill(); _ = daemon.Wait(); log.Close() })
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
			return host{addr, logPath, restore, stop}
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
				// A failed baseline for the same VM ends the wait: it will not be retried by this harness.
				if strings.Contains(line, "compute_baseline") && strings.Contains(line, needles[1]) && !strings.Contains(line, "error=<nil>") {
					t.Fatalf("baseline failed: %s", line)
				}
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatalf("no log line with %q", needles)
		return ""
	}
	stopVM := func(h host, id string) error {
		// The shared image can still be publishing when the guest exits.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		path := "/v1/vms/" + id
		req, err := http.NewRequestWithContext(ctx, "POST", "https://"+h.endpoint+path+"/stop",
			strings.NewReader(`{"checkpoint":false}`))
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusAccepted {
			return fmt.Errorf("stop %s: HTTP %d", id, resp.StatusCode)
		}
		select {
		case callback := <-ended:
			if callback != "/vms/"+id+"/ended" {
				return fmt.Errorf("stop %s: unexpected callback %s", id, callback)
			}
			return nil
		case <-ctx.Done():
			return fmt.Errorf("stop %s: ended callback missing: %w", id, ctx.Err())
		}
	}
	const markerPath = "/workspace/src/d000/f00000.ts"
	const addedPath = "/workspace/src/api-added.ts"
	marker := lineage + " checkpoint"
	session := func(h host, phase, at, version string, checkpoint bool, readEdit string) (time.Duration, string, string) {
		t.Helper()
		id := lineage + "-" + phase
		spec := hostwire.BootSpec{ID: id, Lineage: lineage, Ref: "main", Version: version, Parent: version, Tree: at,
			Image: sha, Shape: shape, Session: &hostwire.Session{IdleStopS: 3600},
			Lease: hostwire.Lease{Holder: hostwire.Holder{Host: cert.HostID, Boot: 9, Mount: id}, Epoch: 1}}
		begin := time.Now()
		call(h, "POST", "/v1/vms", spec, 202)
		stopped := false
		t.Cleanup(func() {
			if !stopped {
				if err := stopVM(h, id); err != nil {
					t.Errorf("cleanup: %v; host log: %s", err, h.log)
				}
			}
		})
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
		const scan = "find /workspace -type f | wc -l; du -sm /workspace | cut -f1"
		command := scan
		readPath := markerPath
		expectedCount := len(files)
		if phase == "api-add" {
			readPath = addedPath
			expectedCount++
		}
		if packedMode != "" {
			command = "sha256sum " + readPath
		} else if readEdit != "" {
			command = "cat " + markerPath
		}
		out := call(h, "POST", "/v1/vms/"+id+"/exec", hostwire.ExecRequest{ExecID: "first", Shell: shell.ShellID,
			Command: command, TimeoutS: 120}, 200)
		elapsed := time.Since(begin) + h.restore
		if cleanMode {
			state, err := os.ReadFile(filepath.Join(filepath.Dir(h.log), "mounts", id, "state.json"))
			must(err)
			var mount struct {
				Warm                  bool
				BaseTree, CachedImage string
			}
			must(json.Unmarshal(state, &mount))
			if !mount.Warm || mount.BaseTree != at || mount.CachedImage != cleanImage.SHA256 {
				t.Fatalf("clean image cache was not used: %+v", mount)
			}
			t.Logf("CLEAN_IMAGE_USED phase=%s tree=%s image=%s warm=true", phase, at, mount.CachedImage)
		}
		if packedMode != "" {
			got, _, _ := strings.Cut(coldExecOutput(t, out), " ")
			expected := files[strings.TrimPrefix(markerPath, "/workspace/")].SHA256
			if readEdit != "" {
				digest := sha256.Sum256([]byte(readEdit + "\n"))
				expected = hex.EncodeToString(digest[:])
			}
			if got != expected {
				t.Fatalf("first read hash %s: got %s, want %s", phase, got, expected)
			}
			mode := packedMode
			if cleanMode {
				mode = "image"
			}
			t.Logf("WORKSPACE_METRIC size_mb=%d phase=%s mode=%s first_read_ms=%.3f", mb, phase, mode, float64(elapsed.Microseconds())/1000)
			out = call(h, "POST", "/v1/vms/"+id+"/exec", hostwire.ExecRequest{ExecID: "scan", Shell: shell.ShellID,
				Command: scan, TimeoutS: 120}, 200)
		} else if readEdit != "" {
			if got := coldExecOutput(t, out); got != readEdit+"\n" {
				t.Fatalf("marker in %s: got %q, want %q", phase, got, readEdit+"\n")
			}
			out = call(h, "POST", "/v1/vms/"+id+"/exec", hostwire.ExecRequest{ExecID: "scan", Shell: shell.ShellID,
				Command: scan, TimeoutS: 120}, 200)
		}
		count, _, _ := strings.Cut(coldExecOutput(t, out), "\n")
		if count != strconv.Itoa(expectedCount) {
			t.Fatalf("workspace has %q files, want %d", count, expectedCount)
		}
		next, nextVersion := at, version
		if checkpoint {
			out := call(h, "POST", "/v1/vms/"+id+"/exec", hostwire.ExecRequest{ExecID: "edit", Shell: shell.ShellID,
				Command: fmt.Sprintf("printf '%%s\\n' %q > %s", marker, markerPath), TimeoutS: 20}, 200)
			if got := coldExecOutput(t, out); got != "" {
				t.Fatalf("unexpected output from marker write: %q", got)
			}
			var reply hostwire.CheckpointReply
			must(json.Unmarshal(call(h, "POST", "/v1/vms/"+id+"/checkpoint", hostwire.CheckpointRequest{Message: "bench"}, 200), &reply))
			if !reply.Changed {
				t.Fatalf("checkpoint did not change: %+v", reply)
			}
			next, nextVersion = reply.Tree, reply.Version
		}
		must(stopVM(h, id))
		stopped = true
		return elapsed, next, nextVersion
	}
	tierDB, err := refs.OpenStorage(filepath.Join(seed, "storage.db"))
	must(err)
	defer tierDB.Close()
	commit := benchmarkStorageAPI(t, &objects.Repository{DB: tierDB, Store: remote, TempDir: seed}, lineage)
	root := commit(nil, tree.Tree, "", "")
	if packedMode != "" {
		generator := &image.Manager{Config: image.Config{Data: seed}, Store: remote, Refs: tierDB}
		apiMarker := lineage + " packed API edit"
		var phases []time.Duration
		target := root
		for _, phase := range []string{"initial", "api-edit", "api-add"} {
			readEdit := ""
			if phase == "api-edit" {
				apiStart := time.Now()
				target = commit([]string{root.Commit}, "", strings.TrimPrefix(markerPath, "/workspace/"), apiMarker+"\n")
				t.Logf("PACKED_APPLY_API_EDIT size_mb=%d codec=%s ms=%.3f", mb, packedMode, float64(time.Since(apiStart).Microseconds())/1000)
				readEdit = apiMarker
			}
			if phase == "api-add" {
				apiStart := time.Now()
				readEdit = lineage + " packed API addition"
				target = commit([]string{target.Commit}, "", strings.TrimPrefix(addedPath, "/workspace/"), readEdit+"\n")
				t.Logf("PACKED_APPLY_API_ADD size_mb=%d codec=%s ms=%.3f", mb, packedMode, float64(time.Since(apiStart).Microseconds())/1000)
			}
			prepared = nil
			if packedMode != "control" {
				build := time.Now()
				packed, err := generator.PreparePackedApply(ctx, lineage, target.Commit, target.Tree, packedMode)
				must(err)
				prepared = &packed
				t.Logf("PACKED_APPLY_BUILD size_mb=%d phase=%s codec=%s ms=%.3f stored_bytes=%d raw_bytes=%d logical_bytes=%d blob=%s sha256=%s raw_sha256=%s commit=%s tree=%s",
					mb, phase, packedMode, float64(time.Since(build).Microseconds())/1000, packed.Size, packed.RawSize, packed.Bytes,
					packed.Blob, packed.SHA256, packed.RawSHA256, packed.Commit, packed.Tree)
			}
			prepareClean(target.Commit, target.Tree)
			h := startHost()
			elapsed, _, _ := session(h, phase, target.Tree, target.Commit, false, readEdit)
			phases = append(phases, elapsed)
			if !cleanMode {
				waitLog(h, "compute_baseline", "vm="+lineage+"-"+phase, "error=<nil>")
			}
			h.stop()
			raw, err := os.ReadFile(h.log)
			must(err)
			for _, line := range strings.Split(string(raw), "\n") {
				if cleanMode && strings.Contains(line, "compute_apply_reads") {
					t.Fatalf("clean image unexpectedly fetched canonical blob content: %s", line)
				}
				if strings.Contains(line, "compute_boot") || strings.Contains(line, "compute_apply") || strings.Contains(line, "compute_baseline") {
					t.Log(line)
				}
			}
		}
		t.Logf("PACKED_APPLY_RESULT size_mb=%d mode=%s files=%d initial_ms=%.3f api_edit_fresh_ms=%.3f api_add_fresh_ms=%.3f",
			mb, packedMode, len(files), float64(phases[0].Microseconds())/1000, float64(phases[1].Microseconds())/1000, float64(phases[2].Microseconds())/1000)
		return
	}

	a := startHost()
	first, _, _ := session(a, "first", tree.Tree, root.Commit, false, "")
	baseline := waitLog(a, "compute_baseline", "vm="+lineage+"-first", "error=<nil>")
	again, edited, editedVersion := session(a, "again", tree.Tree, root.Commit, true, "")
	resumed, _, _ := session(a, "resume", edited, editedVersion, false, marker)
	apiMarker := lineage + " API edit"
	target := commit([]string{editedVersion}, "", strings.TrimPrefix(markerPath, "/workspace/"), apiMarker+"\n")
	if target.Tree == edited || target.Commit == editedVersion {
		t.Fatal("API edit did not produce a new tree and commit")
	}
	editResume, _, _ := session(a, "api-edit", target.Tree, target.Commit, false, apiMarker)
	a.stop()
	b := startHost()
	cross, _, _ := session(b, "cross", target.Tree, target.Commit, false, apiMarker)
	t.Logf("API_EDIT_RESULT size_mb=%d files=%d exact_ms=%d same_host_edit_ms=%d empty_host_edit_ms=%d target=%s",
		mb, len(files), resumed.Milliseconds(), editResume.Milliseconds(), cross.Milliseconds(), target.Tree)
	for _, h := range []host{a, b} {
		raw, err := os.ReadFile(h.log)
		must(err)
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.Contains(line, "compute_boot") || strings.Contains(line, "compute_apply") || strings.Contains(line, "compute_checkpoint") || strings.Contains(line, "compute_baseline") {
				t.Log(line)
			}
		}
	}
	t.Logf("baseline: %s", baseline)
	t.Logf("RESULT size_mb=%d files=%d first_ever_ms=%d same_host_same_tree_ms=%d same_host_checkpointed_ms=%d new_host_tree_rebuild_ms=%d",
		mb, len(files), first.Milliseconds(), again.Milliseconds(), resumed.Milliseconds(), cross.Milliseconds())
}

type apiBenchmarkCommit struct {
	Commit string `json:"commit"`
	Tree   string `json:"tree"`
}

func benchmarkStorageAPI(t *testing.T, repo *objects.Repository, lineage string) func([]string, string, string, string) apiBenchmarkCommit {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	b64 := base64.RawURLEncoding.EncodeToString
	jwks := fmt.Sprintf(`{"keys":[{"kid":"bench","kty":"OKP","crv":"Ed25519","alg":"EdDSA","use":"sig","x":"%s"}]}`, b64(public))
	keys, err := auth.Load("", &jwks, auth.Options{Typ: auth.RuntimeType, Audience: auth.RuntimeAudience, Issuer: "benchmark", MaxTTL: auth.DefaultMaxTTL})
	if err != nil {
		t.Fatal(err)
	}
	server := api.NewStorageServer(repo, "benchmark", keys)
	return func(parents []string, baseTree, path, edit string) apiBenchmarkCommit {
		t.Helper()
		now := time.Now()
		payload, err := json.Marshal(map[string]any{"iss": "benchmark", "aud": auth.RuntimeAudience, "sub": "runtime:benchmark",
			"lin": lineage, "acc": "w", "refs": []string{"main"}, "iat": now.Unix(), "exp": now.Add(time.Minute).Unix()})
		if err != nil {
			t.Fatal(err)
		}
		unsigned := b64([]byte(`{"kid":"bench","alg":"EdDSA","typ":"camelfs+jwt"}`)) + "." + b64(payload)
		token := unsigned + "." + b64(ed25519.Sign(private, []byte(unsigned)))
		call := func(method, route string, raw []byte, out any) {
			t.Helper()
			req := httptest.NewRequest(method, "/v1/lineages/"+lineage+"/"+route, bytes.NewReader(raw))
			req.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			server.ServeHTTP(w, req)
			if w.Code != http.StatusCreated {
				t.Fatalf("storage API %s %s: %d %s", method, route, w.Code, w.Body.String())
			}
			if err := json.Unmarshal(w.Body.Bytes(), out); err != nil {
				t.Fatal(err)
			}
		}
		changes := []map[string]string{}
		if path != "" {
			var upload struct{ Blob string }
			call(http.MethodPut, "blobs", []byte(edit), &upload)
			changes = append(changes, map[string]string{"path": path, "blob": upload.Blob})
		}
		body := map[string]any{"parents": append([]string{}, parents...), "changes": changes, "author": "agent:benchmark", "message": "API edit trial"}
		if baseTree != "" {
			body["baseTree"] = baseTree
		}
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		var reply apiBenchmarkCommit
		call(http.MethodPost, "commits", raw, &reply)
		return reply
	}
}

func coldExecOutput(t *testing.T, response []byte) string {
	t.Helper()
	var stdout, stderr bytes.Buffer
	for _, frame := range bytes.Split(response, []byte("\n\n")) {
		event, payload, ok := bytes.Cut(frame, []byte("\ndata: "))
		if !ok {
			continue
		}
		switch string(event) {
		case "event: stdout", "event: stderr":
			var chunk hostwire.ExecChunk
			if err := json.Unmarshal(payload, &chunk); err != nil {
				t.Fatal(err)
			}
			if string(event) == "event: stdout" {
				stdout.Write(chunk.Data)
			} else {
				stderr.Write(chunk.Data)
			}
		case "event: exit":
			var exit struct {
				hostwire.ExecExit
				Code *int `json:"code"`
			}
			if err := json.Unmarshal(payload, &exit); err != nil {
				t.Fatal(err)
			}
			if exit.Code == nil || *exit.Code != 0 || exit.TimedOut || exit.Truncated || stderr.Len() != 0 {
				t.Fatalf("shell did not exit cleanly: %s, stderr=%q", payload, stderr.String())
			}
			return stdout.String()
		}
	}
	t.Fatalf("missing shell exit: %s", response)
	return ""
}
