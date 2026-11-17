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
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// This qualification uses ordinary daemon VM requests. It never injects an
// image or a tree-cache row. The canonical arm disables prebuilt images only
// in this test helper; camelfsd host always enables the normal prebuilt path.
// Both arms replay the same committed tree and verify every regular file.
func TestKVMPrebuiltSessionQualification(t *testing.T) {
	if os.Getenv("CAMELFSD_KVM") != "1" || os.Getenv("CAMELFSD_KVM_PREBUILT") != "1" {
		t.Skip("set CAMELFSD_KVM=1 and CAMELFSD_KVM_PREBUILT=1 on the exclusive KVM lane")
	}
	for _, name := range []string{"CAMELFSD_KVM_CLEAN_IMAGE", "CAMELFSD_KVM_IMAGE_RANGES", "CAMELFSD_KVM_PACKED_APPLY", "CAMELFSD_KVM_PACKED_PARALLEL", "CAMELFSD_KVM_MEDIUM_BUNDLES"} {
		if os.Getenv(name) != "" {
			t.Fatalf("%s must be unset: qualification exercises ordinary starts", name)
		}
	}
	if store.BundleMaxBlob != 64<<10 {
		t.Fatal("qualification requires the normal 64 KiB bundle contract")
	}
	if order := os.Getenv("CAMELFSD_KVM_PREBUILT_ORDER"); order != "" && order != "canonical-first" && order != "prebuilt-first" {
		t.Fatal("CAMELFSD_KVM_PREBUILT_ORDER must be canonical-first or prebuilt-first")
	}
	url, guest, table := os.Getenv("CAMELFSD_KVM_STORE"), os.Getenv("GUEST_IMAGE"), os.Getenv("CAMELFSD_KVM_OBJECTS_TABLE")
	if !strings.HasPrefix(url, "s3://") || guest == "" || table == "" || os.Getenv("CAMELFSD_KVM_WORK") == "" {
		t.Fatal("scoped CAMELFSD_KVM_STORE, GUEST_IMAGE, CAMELFSD_KVM_OBJECTS_TABLE and CAMELFSD_KVM_WORK are required")
	}
	sizes := os.Getenv("CAMELFSD_KVM_COLD_MB")
	if sizes == "" {
		sizes = "50"
	}
	for _, field := range strings.Split(sizes, ",") {
		mb, err := strconv.Atoi(field)
		if err != nil || mb < 41 {
			t.Fatalf("invalid workspace size %q", field)
		}
		t.Run(fmt.Sprintf("%dMB", mb), func(t *testing.T) { qualifyPrebuiltSession(t, url, guest, table, mb) })
	}
}

type prebuiltQualification struct {
	t             *testing.T
	lineage, url  string
	parent, table string
	guest, sha    string
	kernel        string
	shape         hostwire.Shape
	virtual       int64
	remote        store.Store
	repo          *objects.Repository
	commit        func([]string, string, string, string) apiBenchmarkCommit
	cert          *Identity
	tier          *httptest.Server
	client        *http.Client
	pinned        []byte
	mu            sync.Mutex
	started       map[string]bool
	ended         map[string]hostwire.Ended
}

type prebuiltQualificationHost struct {
	q              *prebuiltQualification
	data, endpoint string
	log            string
	prebuilt       bool
	stop           func()
}

func prebuiltMust(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func qualifyPrebuiltSession(t *testing.T, url, guest, table string, mb int) {
	q := &prebuiltQualification{t: t, lineage: fmt.Sprintf("coldbench-%d-%d", mb, time.Now().UnixNano()), url: url,
		parent: os.Getenv("CAMELFSD_KVM_WORK"), table: table, guest: guest, virtual: int64(mb+1024) << 20,
		kernel: os.Getenv("GUEST_KERNEL"), started: map[string]bool{}, ended: map[string]hostwire.Ended{}}
	if q.kernel == "" {
		q.kernel = "/var/lib/camel/guest/vmlinux"
	}
	t.Logf("benchmark lineage=%s", q.lineage)
	var err error
	q.remote, err = openBenchmarkStore(t.Context(), url, table, store.DefaultDepth)
	prebuiltMust(t, err)
	seed := t.TempDir()
	db, err := refs.OpenStorage(filepath.Join(seed, "storage.db"))
	prebuiltMust(t, err)
	defer db.Close()
	q.repo = (&objects.Repository{DB: db, Store: q.remote, TempDir: seed}).ForLineage(q.lineage)
	q.commit = benchmarkStorageAPI(t, &objects.Repository{DB: db, Store: q.remote, TempDir: seed}, q.lineage)
	files := map[string]objects.File{}
	batch := q.repo.BeginPublication()
	ids := make([]string, 0, 10000)
	for i := range 10000 {
		raw := make([]byte, 4096)
		_, err := rand.Read(raw)
		prebuiltMust(t, err)
		ids = append(ids, batch.StageBlob(raw).SHA1)
		digest := sha256.Sum256(raw)
		files[fmt.Sprintf("src/d%03d/f%05d.ts", i/100, i)] = objects.File{SHA256: hex.EncodeToString(digest[:])}
	}
	prebuiltMust(t, batch.Flush(t.Context()))
	locations, err := store.LocateBundles(t.Context(), store.ForLineage(q.remote, q.lineage), ids)
	prebuiltMust(t, err)
	packs := map[string]bool{}
	for _, location := range locations {
		packs[location.Key] = true
	}
	if len(locations) != 10000 || len(packs) == 0 || len(packs) >= 10000 {
		t.Fatalf("invalid bundled seed: %d locators in %d packs", len(locations), len(packs))
	}
	t.Logf("seed bundles: %d blobs in %d packs", len(locations), len(packs))
	for i := range mb - 40 {
		raw := make([]byte, 1<<20)
		_, err := rand.Read(raw)
		prebuiltMust(t, err)
		digest := sha256.Sum256(raw)
		sha := hex.EncodeToString(digest[:])
		_, err = q.repo.Upload(t.Context(), q.lineage, sha, int64(len(raw)), bytes.NewReader(raw))
		prebuiltMust(t, err)
		files[fmt.Sprintf("assets/a%04d.bin", i)] = objects.File{SHA256: sha}
	}
	imported, err := q.repo.Import(t.Context(), objects.Request{Lineage: q.lineage, Files: files})
	prebuiltMust(t, err)
	initial := q.commit(nil, imported.Tree, "", "")
	t.Logf("PREBUILT_FIXTURE size_mb=%d files=%d commit=%s tree=%s", mb, len(files), initial.Commit, initial.Tree)
	q.setup()
	const marker = "src/d000/f00000.ts"
	const added = "src/api-added.ts"
	firstHash := files[marker].SHA256
	arms := []string{"canonical-control", "prebuilt"}
	if os.Getenv("CAMELFSD_KVM_PREBUILT_ORDER") == "prebuilt-first" {
		arms[0], arms[1] = arms[1], arms[0]
	}
	for _, arm := range arms {
		prebuilt := arm == "prebuilt"
		a := q.host(prebuilt)
		q.session(a, mb, arm, "first-miss", initial, files, marker, firstHash, false)
		if !prebuilt {
			q.waitBaseline(a, q.lineage+"-"+arm+"-first-miss")
		}
		q.session(a, mb, arm, "local-hit", initial, files, marker, firstHash, false)
		a.stop()
		b := q.host(prebuilt)
		q.session(b, mb, arm, "remote-hit", initial, files, marker, firstHash, false)
		b.stop()
	}
	// API changes use the public storage handler and produce new immutable trees.
	editedText := q.lineage + " API edit\n"
	edited := q.commit([]string{initial.Commit}, "", marker, editedText)
	editedFiles := prebuiltCopyFiles(files)
	editedFiles[marker] = prebuiltFile(editedText, "100644")
	addedText := q.lineage + " API add\n"
	addedVersion := q.commit([]string{edited.Commit}, "", added, addedText)
	addedFiles := prebuiltCopyFiles(editedFiles)
	addedFiles[added] = prebuiltFile(addedText, "100644")
	for _, target := range []struct {
		phase, path string
		version     apiBenchmarkCommit
		files       map[string]objects.File
	}{{"api-edit", marker, edited, editedFiles}, {"api-add", added, addedVersion, addedFiles}} {
		for _, arm := range arms {
			h := q.host(arm == "prebuilt")
			q.session(h, mb, arm, target.phase, target.version, target.files, target.path, target.files[target.path].SHA256, false)
			h.stop()
		}
	}
	// A normal changed checkpoint publishes canonical bytes, modes and links.
	h := q.host(true)
	checkpoint := q.session(h, mb, "prebuilt", "checkpoint", addedVersion, addedFiles, added, addedFiles[added].SHA256, true)
	h.stop()
	checkpointFiles := prebuiltCopyFiles(addedFiles)
	checkpointFiles["proof.txt"] = prebuiltFile("checkpoint payload\n", "100644")
	checkpointFiles["proof.sh"] = prebuiltFile("#!/bin/sh\nprintf 'executable-ok\\n'\n", "100755")
	checkpointFiles["proof-link"] = prebuiltFile("proof.txt", "120000")
	raw, err := q.repo.Object(t.Context(), checkpoint.Commit, "commit")
	prebuiltMust(t, err)
	if !bytes.Contains(raw, []byte("parent "+addedVersion.Commit+"\n")) {
		t.Fatal("checkpoint did not retain its exact parent commit")
	}
	entries, err := q.repo.TreeEntries(t.Context(), checkpoint.Tree)
	prebuiltMust(t, err)
	for _, entry := range entries {
		if expected, ok := checkpointFiles[entry.Path]; ok && expected.Mode != "" && entry.Mode != expected.Mode {
			t.Fatalf("checkpoint mode %s=%s, want %s", entry.Path, entry.Mode, expected.Mode)
		}
	}
	for _, arm := range arms {
		other := q.host(arm == "prebuilt")
		q.session(other, mb, arm, "checkpoint-recovery", checkpoint, checkpointFiles, "proof.txt", checkpointFiles["proof.txt"].SHA256, false)
		other.stop()
	}
	other := q.host(true)
	q.session(other, mb, "prebuilt", "checkpoint-remote", checkpoint, checkpointFiles, "proof.txt", checkpointFiles["proof.txt"].SHA256, false)
	other.stop()
	if mb == 50 {
		q.corruptArtifact(initial)
	}
}

func prebuiltFile(content, mode string) objects.File {
	digest := sha256.Sum256([]byte(content))
	return objects.File{SHA256: hex.EncodeToString(digest[:]), Mode: mode}
}

func prebuiltCopyFiles(files map[string]objects.File) map[string]objects.File {
	out := make(map[string]objects.File, len(files)+3)
	for path, file := range files {
		out[path] = file
	}
	return out
}

func (q *prebuiltQualification) setup() {
	t := q.t
	cert, tierPair := testIdentity(t)
	q.cert = cert
	for _, ca := range cert.ca.certs {
		q.pinned = append(q.pinned, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.Raw})...)
	}
	f, err := os.Open(q.guest)
	prebuiltMust(t, err)
	hash := sha256.New()
	size, err := io.Copy(hash, f)
	prebuiltMust(t, err)
	prebuiltMust(t, f.Close())
	q.sha = hex.EncodeToString(hash.Sum(nil))
	q.shape = hostwire.Shape{VCPUs: 2, MemoryMiB: 2048, DiskMiB: int(max(1024, (size+(1<<20)-1)>>20))}
	q.tier = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := strings.TrimPrefix(r.URL.Path, "/v1/hosts/"+q.cert.HostID)
		switch {
		case route == "/register":
			jsonReply(w, 200, hostwire.Registered{BootEpoch: 9})
		case route == "/heartbeat":
			jsonReply(w, 200, hostwire.HeartbeatReply{BootEpoch: 9})
		case strings.HasSuffix(route, "/started"):
			id := strings.TrimSuffix(strings.TrimPrefix(route, "/vms/"), "/started")
			q.mu.Lock()
			q.started[id] = true
			q.mu.Unlock()
			w.WriteHeader(204)
		case strings.HasSuffix(route, "/ended"):
			var ended hostwire.Ended
			if err := json.NewDecoder(r.Body).Decode(&ended); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			id := strings.TrimSuffix(strings.TrimPrefix(route, "/vms/"), "/ended")
			q.mu.Lock()
			q.ended[id] = ended
			q.mu.Unlock()
			w.WriteHeader(204)
		case route == "/lineages/"+q.lineage+"/refs/main/cas":
			var request struct{ Commit string }
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			raw, err := q.repo.Object(r.Context(), request.Commit, "commit")
			if err != nil {
				t.Error(err)
				w.WriteHeader(500)
				return
			}
			jsonReply(w, 200, hostwire.CheckpointReply{Version: request.Commit, Tree: strings.Fields(string(raw))[1], Diff: json.RawMessage("[]")})
		default:
			t.Errorf("unexpected tier route %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	q.tier.TLS = cert.current.Load().server.Clone()
	q.tier.TLS.Certificates[0] = tierPair
	q.tier.TLS.VerifyConnection = nil
	q.tier.StartTLS()
	t.Cleanup(q.tier.Close)
	q.client = &http.Client{Timeout: 10 * time.Minute, Transport: &http.Transport{DisableKeepAlives: true, TLSClientConfig: tierClientTLS(cert, tierPair)}}
}

func (q *prebuiltQualification) host(prebuilt bool) *prebuiltQualificationHost {
	t := q.t
	data, err := os.MkdirTemp(q.parent, "prebuilt-session-")
	prebuiltMust(t, err)
	t.Cleanup(func() {
		if !t.Failed() && os.Getenv("CAMELFSD_KVM_KEEP") != "1" {
			prebuiltMust(t, os.RemoveAll(data))
		} else {
			t.Logf("qualification data=%s", data)
		}
	})
	prebuiltMust(t, os.WriteFile(filepath.Join(data, "tier-ca.pem"), q.pinned, 0600))
	for _, name := range []string{"host-key.pem", "host-certificate.json"} {
		raw, err := os.ReadFile(filepath.Join(q.cert.dir, name))
		prebuiltMust(t, err)
		prebuiltMust(t, os.WriteFile(filepath.Join(data, name), raw, 0600))
	}
	prebuiltMust(t, os.Mkdir(filepath.Join(data, "images"), 0700))
	prebuiltMust(t, exec.Command("cp", "--reflink=always", q.guest, filepath.Join(data, "images", q.sha+".ext4")).Run())
	cfg := kvmDaemonConfig{Data: data, Tier: strings.TrimPrefix(q.tier.URL, "https://"), HostID: q.cert.HostID, Kernel: q.kernel,
		Shape: q.shape, Store: q.url, ObjectsTable: q.table, VirtualSize: q.virtual, PrebuiltImages: prebuilt}
	raw, err := json.Marshal(cfg)
	prebuiltMust(t, err)
	process := exec.Command(os.Args[0], "-test.run=^TestKVMComputeDaemonProcess$")
	process.Env = append(os.Environ(), "CAMELFSD_KVM_DAEMON="+string(raw))
	stdout, err := process.StdoutPipe()
	prebuiltMust(t, err)
	h := &prebuiltQualificationHost{q: q, data: data, log: filepath.Join(data, "daemon.log"), prebuilt: prebuilt}
	log, err := os.OpenFile(h.log, os.O_CREATE|os.O_WRONLY, 0600)
	prebuiltMust(t, err)
	process.Stderr = log
	prebuiltMust(t, process.Start())
	h.stop = sync.OnceFunc(func() {
		_ = process.Process.Kill()
		_ = process.Wait()
		prebuiltMust(t, log.Close())
		raw, err := os.ReadFile(h.log)
		prebuiltMust(t, err)
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.Contains(line, "compute_") {
				t.Log(line)
			}
		}
	})
	t.Cleanup(h.stop)
	ready := make(chan string, 1)
	go func() {
		scan := bufio.NewScanner(stdout)
		for scan.Scan() {
			if address, ok := strings.CutPrefix(scan.Text(), "ADDR "); ok {
				ready <- address
			}
		}
	}()
	select {
	case h.endpoint = <-ready:
	case <-time.After(time.Minute):
		t.Fatal("qualification daemon did not start")
	}
	return h
}

func (h *prebuiltQualificationHost) call(method, path string, value any, status int) []byte {
	t := h.q.t
	t.Helper()
	raw, err := json.Marshal(value)
	prebuiltMust(t, err)
	request, err := http.NewRequestWithContext(t.Context(), method, "https://"+h.endpoint+path, bytes.NewReader(raw))
	prebuiltMust(t, err)
	response, err := h.q.client.Do(request)
	prebuiltMust(t, err)
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	prebuiltMust(t, err)
	if response.StatusCode != status {
		t.Fatalf("%s %s: HTTP %d, want %d: %s", method, path, response.StatusCode, status, body)
	}
	return body
}

func (q *prebuiltQualification) spec(id string, target apiBenchmarkCommit) hostwire.BootSpec {
	return hostwire.BootSpec{ID: id, Lineage: q.lineage, Ref: "main", Version: target.Commit, Parent: target.Commit, Tree: target.Tree,
		Image: q.sha, Shape: q.shape, Session: &hostwire.Session{IdleStopS: 3600},
		Lease: hostwire.Lease{Holder: hostwire.Holder{Host: q.cert.HostID, Boot: 9, Mount: id}, Epoch: 1}}
}

func (q *prebuiltQualification) waitEnded(id string) hostwire.Ended {
	q.t.Helper()
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		q.mu.Lock()
		ended, ok := q.ended[id]
		q.mu.Unlock()
		if ok {
			return ended
		}
		time.Sleep(20 * time.Millisecond)
	}
	q.t.Fatalf("VM %s did not end", id)
	return hostwire.Ended{}
}

func (q *prebuiltQualification) session(h *prebuiltQualificationHost, mb int, arm, phase string, target apiBenchmarkCommit, files map[string]objects.File, firstPath, firstSHA string, checkpoint bool) apiBenchmarkCommit {
	t := q.t
	t.Helper()
	id := q.lineage + "-" + arm + "-" + phase
	// Repeated trees get distinct VM IDs, while every fresh data dir is empty.
	path := "/v1/vms/" + id
	before, err := os.ReadFile(h.log)
	prebuiltMust(t, err)
	begin := time.Now()
	h.call("POST", "/v1/vms", q.spec(id, target), 202)
	stopped := false
	t.Cleanup(func() {
		if !stopped {
			h.call("POST", path+"/stop", hostwire.Stop{Checkpoint: false}, 202)
			q.waitEnded(id)
		}
	})
	var shell hostwire.ShellCreated
	for time.Since(begin) < 10*time.Minute {
		payload, _ := json.Marshal(hostwire.ShellRequest{})
		response, err := q.client.Post("https://"+h.endpoint+path+"/shells", "application/json", bytes.NewReader(payload))
		prebuiltMust(t, err)
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		prebuiltMust(t, err)
		if response.StatusCode == 201 {
			prebuiltMust(t, json.Unmarshal(body, &shell))
			break
		}
		if response.StatusCode != 409 {
			t.Fatalf("shell: HTTP %d: %s", response.StatusCode, body)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if shell.ShellID == "" {
		t.Fatal("qualification VM did not become ready")
	}
	run := func(execID, command string, stdin *string) string {
		return coldExecOutput(t, h.call("POST", path+"/exec", hostwire.ExecRequest{ExecID: execID, Shell: shell.ShellID, Command: command, Stdin: stdin, TimeoutS: 120}, 200))
	}
	first := run("first", "sha256sum /workspace/"+firstPath, nil)
	elapsed := time.Since(begin)
	got, _, _ := strings.Cut(first, " ")
	if got != firstSHA {
		t.Fatalf("%s %s first hash %s, want %s", arm, phase, got, firstSHA)
	}
	t.Logf("PREBUILT_SESSION_METRIC size_mb=%d arm=%s phase=%s first_read_ms=%.3f commit=%s tree=%s", mb, arm, phase, float64(elapsed.Microseconds())/1000, target.Commit, target.Tree)
	paths := make([]string, 0, len(files))
	for name, file := range files {
		if file.Mode != "120000" {
			paths = append(paths, name)
		}
	}
	sort.Strings(paths)
	var manifest strings.Builder
	for _, name := range paths {
		fmt.Fprintf(&manifest, "%s  %s\n", files[name].SHA256, name)
	}
	checksums := manifest.String()
	if out := run("verify-all", "cd /workspace && sha256sum --check --quiet", &checksums); out != "" {
		t.Fatalf("unexpected checksum output: %q", out)
	}
	if out := run("count", "find /workspace -type f | wc -l", nil); strings.TrimSpace(out) != strconv.Itoa(len(paths)) {
		t.Fatalf("regular file count %q, want %d", out, len(paths))
	}
	if _, ok := files["proof-link"]; ok {
		if out := run("modes", "test -L /workspace/proof-link && test \"$(readlink /workspace/proof-link)\" = proof.txt && test \"$(stat -c %a /workspace/proof.sh)\" = 755 && /workspace/proof.sh", nil); out != "executable-ok\n" {
			t.Fatalf("checkpoint link/executable output %q", out)
		}
	}
	var mount image.Mount
	raw, err := os.ReadFile(filepath.Join(h.data, "mounts", id, "state.json"))
	prebuiltMust(t, err)
	prebuiltMust(t, json.Unmarshal(raw, &mount))
	if h.prebuilt && (!mount.Warm || mount.BaseTree != target.Tree || mount.CachedImage == "") {
		t.Fatalf("prebuilt startup did not mount the exact tree: %+v", mount)
	}
	if phase == "local-hit" && (!mount.Warm || mount.BaseTree != target.Tree) {
		t.Fatalf("%s local hit did not reuse the exact image: %+v", arm, mount)
	}
	logs, err := os.ReadFile(h.log)
	prebuiltMust(t, err)
	newLogs := string(logs[len(before):])
	if !h.prebuilt || phase == "local-hit" {
		if strings.Contains(newLogs, "compute_prebuilt_image") {
			t.Fatalf("%s %s unexpectedly prepared a remote image: %s", arm, phase, newLogs)
		}
	} else {
		mode := "build"
		if phase == "remote-hit" || phase == "checkpoint" || phase == "checkpoint-remote" {
			mode = "remote"
		}
		found := false
		for _, line := range strings.Split(newLogs, "\n") {
			if strings.Contains(line, "compute_prebuilt_image") && strings.Contains(line, "mode="+mode) && strings.Contains(line, "tree="+target.Tree) {
				found = true
			}
			if strings.Contains(line, "compute_apply_reads") && strings.Contains(line, "vm="+id) {
				t.Fatalf("prebuilt start fetched canonical payloads in apply: %s", line)
			}
		}
		if !found {
			t.Fatalf("%s missing production prebuilt %s receipt for %s: %s", phase, mode, target.Tree, newLogs)
		}
	}
	if checkpoint {
		script := "#!/bin/sh\nprintf 'executable-ok\\n'\n"
		run("edit", "set -e; printf 'checkpoint payload\\n' > /workspace/proof.txt; cat > /workspace/proof.sh", &script)
		run("edit-modes", "set -e; chmod 755 /workspace/proof.sh; ln -s proof.txt /workspace/proof-link", nil)
		var changed, unchanged hostwire.CheckpointReply
		prebuiltMust(t, json.Unmarshal(h.call("POST", path+"/checkpoint", hostwire.CheckpointRequest{Message: "prebuilt qualification"}, 200), &changed))
		prebuiltMust(t, json.Unmarshal(h.call("POST", path+"/checkpoint", hostwire.CheckpointRequest{}, 200), &unchanged))
		if !changed.Changed || unchanged.Changed || changed.Version == target.Commit || changed.Version != unchanged.Version {
			t.Fatalf("checkpoint results %+v %+v", changed, unchanged)
		}
		target = apiBenchmarkCommit{Commit: changed.Version, Tree: changed.Tree}
	}
	h.call("POST", path+"/stop", hostwire.Stop{Checkpoint: false}, 202)
	ended := q.waitEnded(id)
	stopped = true
	if ended.Code != "stopped" || ended.Version != target.Commit || ended.CheckpointError != "" {
		t.Fatalf("ended VM %+v, want checkpoint %s", ended, target.Commit)
	}
	return target
}

func (q *prebuiltQualification) waitBaseline(h *prebuiltQualificationHost, id string) {
	q.t.Helper()
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(h.log)
		prebuiltMust(q.t, err)
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.Contains(line, "compute_baseline ") && strings.Contains(line, "vm="+id) {
				if !strings.Contains(line, "error=<nil>") {
					q.t.Fatalf("canonical baseline failed: %s", line)
				}
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	q.t.Fatalf("canonical baseline did not publish for %s", id)
}

func (q *prebuiltQualification) corruptArtifact(initial apiBenchmarkCommit) {
	t := q.t
	// This tree exists solely for fault injection, so no valid test tree's
	// content-addressed image is overwritten. Cleanup removes the run prefix.
	text := q.lineage + " corrupt artifact\n"
	file := prebuiltFile(text, "100644")
	_, err := q.repo.Upload(t.Context(), q.lineage, file.SHA256, int64(len(text)), strings.NewReader(text))
	prebuiltMust(t, err)
	files := map[string]objects.File{"corrupt-only": file}
	imported, err := q.repo.Import(t.Context(), objects.Request{Lineage: q.lineage, Files: files})
	prebuiltMust(t, err)
	target := q.commit([]string{initial.Commit}, imported.Tree, "", "")
	h := q.host(true)
	// Build through a normal request; abort before any test-only cache mutation.
	q.session(h, 50, "prebuilt", "corrupt-prepare", target, files, "corrupt-only", file.SHA256, false)
	h.stop()
	descriptor, found, err := store.GetWorkspaceImage(t.Context(), q.remote, q.lineage, target.Tree, q.virtual)
	prebuiltMust(t, err)
	if !found {
		t.Fatal("normal start did not publish a workspace image descriptor")
	}
	client, bucket, prefix := portableImageS3(t, q.url)
	key := prefix + "/" + q.lineage + "/" + descriptor.Blob
	_, err = client.PutObject(t.Context(), &s3.PutObjectInput{Bucket: aws.String(bucket), Key: aws.String(key), Body: strings.NewReader("corrupt")})
	prebuiltMust(t, err)
	broken := q.host(true)
	id := q.lineage + "-corrupt-reject"
	broken.call("POST", "/v1/vms", q.spec(id, target), 202)
	ended := q.waitEnded(id)
	q.mu.Lock()
	started := q.started[id]
	q.mu.Unlock()
	if ended.Code != "start_failed" || started {
		t.Fatalf("corrupt artifact became runnable: started=%t ended=%+v", started, ended)
	}
	broken.call("POST", "/v1/vms/"+id+"/shells", hostwire.ShellRequest{}, 404)
	for _, dir := range []string{"mounts", "workspace-images"} {
		entries, err := os.ReadDir(filepath.Join(broken.data, dir))
		if err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatalf("corrupt artifact left %s entries: %v", dir, entries)
		}
	}
	broken.stop()
	db, err := refs.Open(filepath.Join(broken.data, "refs.db"))
	prebuiltMust(t, err)
	defer db.Close()
	root, err := db.TreeRoot(q.lineage, target.Tree)
	prebuiltMust(t, err)
	if root != "" {
		t.Fatalf("corrupt artifact published a tree-cache entry: %s", root)
	}
	t.Logf("PREBUILT_CORRUPTION_REJECTED tree=%s blob=%s code=%s", target.Tree, descriptor.Blob, ended.Code)
}
