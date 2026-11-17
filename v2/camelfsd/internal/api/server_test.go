package api_test

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/api"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/auth"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/repo"
	localstore "github.com/qaml-ai/camelrun-next/camelfsd/internal/store/local"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/vm"
)

type testEnv struct {
	srv       *httptest.Server
	privKey   ed25519.PrivateKey
	devToken  string
	hostToken string
}

func setupTestServer(t *testing.T, useRemoteDriver bool) *testEnv {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	dir := t.TempDir()
	st, err := localstore.Open(dir)
	if err != nil {
		t.Fatalf("localstore.Open: %v", err)
	}
	verifier, err := auth.NewVerifier(auth.Config{
		PublicKeysSpec: "kid1:" + base64.RawURLEncoding.EncodeToString(pub),
		DevToken:       "dev-tok-secret",
		HostToken:      "host-tok-secret",
	})
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	mux := vm.NewHostMux(st, time.Now)
	var drv vm.Driver
	if useRemoteDriver {
		drv = vm.NewRemoteDriver(mux)
	} else {
		drv, err = vm.NewLocalDriver(dir)
		if err != nil {
			t.Fatalf("NewLocalDriver: %v", err)
		}
	}

	repoEng := repo.NewEngine(st, time.Now)
	vmMgr := vm.NewManager(vm.ManagerConfig{
		Store:   st,
		Repo:    repoEng,
		Driver:  drv,
		HostMux: mux,
	})
	apiSrv := api.NewServer(verifier, repoEng, vmMgr)
	ts := httptest.NewServer(apiSrv)

	t.Cleanup(func() {
		ts.Close()
		_ = vmMgr.Close()
		_ = st.Close()
	})
	return &testEnv{
		srv:       ts,
		privKey:   priv,
		devToken:  "dev-tok-secret",
		hostToken: "host-tok-secret",
	}
}

func (e *testEnv) mintJWT(t *testing.T, tenant, lin string, scopes []string, ttl time.Duration) string {
	t.Helper()
	tok, err := auth.SignToken("kid1", e.privKey, auth.Claims{
		Iss:    "camelrun",
		Sub:    tenant,
		Lin:    lin,
		Scopes: scopes,
		Exp:    time.Now().Add(ttl).Unix(),
	})
	if err != nil {
		t.Fatalf("SignToken: %v", err)
	}
	return tok
}

func doJSON(t *testing.T, method, url, bearer string, reqBody any, dst any) int {
	t.Helper()
	var bodyReader io.Reader
	if reqBody != nil {
		raw, err := json.Marshal(reqBody)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		bodyReader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("HTTP %s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if dst != nil && len(respBytes) > 0 {
		if err := json.Unmarshal(respBytes, dst); err != nil {
			t.Fatalf("unmarshal %s %s (%d): %v\nraw: %s", method, url, resp.StatusCode, err, string(respBytes))
		}
	}
	return resp.StatusCode
}

func TestHTTPContractEndToEndRepoVMAndSSE(t *testing.T) {
	env := setupTestServer(t, false)
	base := env.srv.URL

	// 1. /healthz unauthenticated
	var health map[string]bool
	if code := doJSON(t, "GET", base+"/healthz", "", nil, &health); code != 200 || !health["ok"] {
		t.Fatalf("expected 200 ok healthz, got %d %+v", code, health)
	}

	// 2. Auth checks: missing token, expired token, wrong scope, wrong lineage
	var errEnv struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if code := doJSON(t, "POST", base+"/v1/lineages", "", map[string]any{}, &errEnv); code != 401 || errEnv.Error.Code != "unauthorized" {
		t.Fatalf("expected 401 unauthorized, got %d %+v", code, errEnv)
	}
	readOnlyTok := env.mintJWT(t, "ten_1", "*", []string{"repo:read"}, 5*time.Minute)
	if code := doJSON(t, "POST", base+"/v1/lineages", readOnlyTok, map[string]any{}, &errEnv); code != 403 || errEnv.Error.Code != "unauthorized" {
		t.Fatalf("expected 403 unauthorized for missing repo:write, got %d %+v", code, errEnv)
	}

	fullTok := env.mintJWT(t, "ten_1", "*", []string{"repo:read", "repo:write", "vm:exec"}, 10*time.Minute)

	// 3. Create lineage + write initial files
	var createRes repo.CreateLineageResponse
	if code := doJSON(t, "POST", base+"/v1/lineages", fullTok, map[string]any{"lineage": "lin_e2e"}, &createRes); code != 200 {
		t.Fatalf("POST /v1/lineages failed: %d", code)
	}

	// Token scoped to another lineage must be rejected on lin_e2e!
	otherLinTok := env.mintJWT(t, "ten_1", "lin_other", []string{"repo:read"}, 5*time.Minute)
	if code := doJSON(t, "GET", base+"/v1/lineages/lin_e2e/refs", otherLinTok, nil, &errEnv); code != 403 || errEnv.Error.Code != "unauthorized" {
		t.Fatalf("expected 403 unauthorized for wrong lineage, got %d %+v", code, errEnv)
	}

	var writeRes repo.WriteResponse
	if code := doJSON(t, "POST", base+"/v1/lineages/lin_e2e/write", fullTok, repo.WriteRequest{
		Ref:     "refs/heads/main",
		Author:  "agent:agt_e2e",
		Message: "initial src",
		Puts: []repo.WritePut{
			{Path: "src/index.ts", Content: "console.log(1)\n", Mode: 420},
		},
	}, &writeRes); code != 200 || writeRes.TotalBytes != 15 {
		t.Fatalf("POST /write failed: %d %+v", code, writeRes)
	}

	// 4. Boot Session VM on (lin_e2e, refs/heads/main) as holder agt_e2e
	var vmBoot vm.BootVMResponse
	if code := doJSON(t, "POST", base+"/v1/vms", fullTok, vm.BootVMRequest{
		Lineage:   "lin_e2e",
		Ref:       "refs/heads/main",
		Holder:    "agt_e2e",
		VCPUs:     2,
		MemoryMiB: 1024,
		LeaseS:    300,
		Env:       map[string]string{"CI": "1"},
	}, &vmBoot); code != 200 || vmBoot.State != "running" || vmBoot.HeadCommit != writeRes.Commit {
		t.Fatalf("POST /v1/vms failed: %d %+v", code, vmBoot)
	}

	// Verify GET /v1/lineages/lin_e2e/refs reports active lease for agt_e2e
	var refsRes struct {
		Refs []struct {
			Name  string `json:"name"`
			Lease *struct {
				Holder string `json:"holder"`
				Epoch  int64  `json:"epoch"`
			} `json:"lease"`
		} `json:"refs"`
	}
	if code := doJSON(t, "GET", base+"/v1/lineages/lin_e2e/refs?prefix=refs/heads/", env.devToken, nil, &refsRes); code != 200 {
		t.Fatalf("GET /refs failed: %d", code)
	}
	if len(refsRes.Refs) != 1 || refsRes.Refs[0].Lease == nil || refsRes.Refs[0].Lease.Holder != "agt_e2e" {
		t.Fatalf("expected active lease on main in /refs, got %+v", refsRes)
	}

	// 5. Seamless live VM /write rule:
	// - Different holder -> 409 ref_leased
	if code := doJSON(t, "POST", base+"/v1/lineages/lin_e2e/write", fullTok, repo.WriteRequest{
		Ref:    "refs/heads/main",
		Holder: "agt_other",
		Puts:   []repo.WritePut{{Path: "intrude.txt", Content: "no"}},
	}, &errEnv); code != 409 || errEnv.Error.Code != "ref_leased" {
		t.Fatalf("expected 409 ref_leased for different holder during active VM, got %d %+v", code, errEnv)
	}

	// - SAME holder -> writes directly into live VM /workspace AND commits to ref!
	var liveWriteRes repo.WriteResponse
	if code := doJSON(t, "POST", base+"/v1/lineages/lin_e2e/write", fullTok, repo.WriteRequest{
		Ref:     "refs/heads/main",
		Holder:  "agt_e2e",
		Author:  "agent:agt_e2e",
		Message: "live tool write while VM active",
		Puts:    []repo.WritePut{{Path: "src/from_tool.txt", Content: "written-by-file-tool\n"}},
	}, &liveWriteRes); code != 200 {
		t.Fatalf("live /write by owning holder failed: %d", code)
	}

	// 6. SSE Streaming Exec (Accept: text/event-stream):
	// Verify bash immediately sees src/from_tool.txt inside /workspace, emits stdout + stderr SSE chunks,
	// creates bash_out.txt, and atomically commits without conflicting with the prior /write!
	execReqBody, _ := json.Marshal(vm.ExecRequest{
		ExecID:  "exec_sse_1",
		Command: `cat src/from_tool.txt && echo "warn-line" >&2 && echo "from-bash-$CI" > bash_out.txt`,
		Commit:  &vm.ExecCommitOptions{Author: "agent:agt_e2e", Message: "bash sse exec"},
	})
	sseHTTPReq, _ := http.NewRequest("POST", fmt.Sprintf("%s/v1/vms/%s/exec", base, vmBoot.VMID), bytes.NewReader(execReqBody))
	sseHTTPReq.Header.Set("Authorization", "Bearer "+fullTok)
	sseHTTPReq.Header.Set("Content-Type", "application/json")
	sseHTTPReq.Header.Set("Accept", "text/event-stream")

	sseResp, err := http.DefaultClient.Do(sseHTTPReq)
	if err != nil {
		t.Fatalf("SSE exec request: %v", err)
	}
	defer sseResp.Body.Close()
	if sseResp.StatusCode != 200 || !strings.Contains(sseResp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("expected 200 text/event-stream, got %d %s", sseResp.StatusCode, sseResp.Header.Get("Content-Type"))
	}

	var stdoutChunks, stderrChunks string
	var finalExec vm.ExecResponse
	gotResult := false

	scanner := bufio.NewScanner(sseResp.Body)
	var curEvent string
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event: ") {
			curEvent = strings.TrimPrefix(line, "event: ")
		} else if strings.HasPrefix(line, "data: ") {
			dataJSON := strings.TrimPrefix(line, "data: ")
			switch curEvent {
			case "stdout":
				var c struct {
					Chunk string `json:"chunk"`
				}
				_ = json.Unmarshal([]byte(dataJSON), &c)
				stdoutChunks += c.Chunk
			case "stderr":
				var c struct {
					Chunk string `json:"chunk"`
				}
				_ = json.Unmarshal([]byte(dataJSON), &c)
				stderrChunks += c.Chunk
			case "result":
				if err := json.Unmarshal([]byte(dataJSON), &finalExec); err != nil {
					t.Fatalf("unmarshal SSE result: %v", err)
				}
				gotResult = true
			}
		}
	}
	if !gotResult {
		t.Fatalf("did not receive SSE result event")
	}
	if !strings.Contains(stdoutChunks, "written-by-file-tool") || !strings.Contains(stderrChunks, "warn-line") {
		t.Fatalf("unexpected SSE streams: stdout=%q stderr=%q", stdoutChunks, stderrChunks)
	}
	if !finalExec.Commit.Changed || len(finalExec.Commit.FilesChanged) != 1 || finalExec.Commit.FilesChanged[0] != "bash_out.txt" {
		t.Fatalf("expected bash_out.txt in atomic commit, got %+v", finalExec.Commit)
	}

	// 7. Verify /read and /history immediately reflect BOTH the live /write AND the post-exec commit!
	var readBash repo.ReadResponse
	if code := doJSON(t, "GET", base+"/v1/lineages/lin_e2e/read?at=refs/heads/main&path=bash_out.txt", fullTok, nil, &readBash); code != 200 {
		t.Fatalf("GET /read bash_out.txt failed: %d", code)
	}
	if readBash.Content == nil || *readBash.Content != "from-bash-1\n" {
		t.Fatalf("unexpected bash_out.txt content: %+v", readBash)
	}

	var histRes repo.HistoryResponse
	if code := doJSON(t, "GET", base+"/v1/lineages/lin_e2e/history?ref=refs/heads/main&limit=10", fullTok, nil, &histRes); code != 200 {
		t.Fatalf("GET /history failed: %d", code)
	}
	if len(histRes.Commits) != 4 { // bash sse exec, live tool write, initial src, initial commit
		t.Fatalf("expected 4 commits in history, got %d", len(histRes.Commits))
	}

	// 8. Renew VM lease & stop VM
	var renewRes vm.RenewLeaseResponse
	if code := doJSON(t, "POST", fmt.Sprintf("%s/v1/vms/%s/lease", base, vmBoot.VMID), fullTok, vm.RenewLeaseRequest{LeaseS: 900}, &renewRes); code != 200 || renewRes.State != "running" {
		t.Fatalf("POST /v1/vms/{id}/lease failed: %d %+v", code, renewRes)
	}

	var stopRes vm.StopVMResponse
	if code := doJSON(t, "POST", fmt.Sprintf("%s/v1/vms/%s/stop", base, vmBoot.VMID), fullTok, map[string]any{}, &stopRes); code != 200 || stopRes.State != "stopped" {
		t.Fatalf("POST /v1/vms/{id}/stop failed: %d %+v", code, stopRes)
	}

	// 9. Merge conflict HTTP 409 response shape check
	if code := doJSON(t, "POST", base+"/v1/lineages/lin_e2e/refs", fullTok, repo.SetRefRequest{
		Ref:    "refs/heads/side",
		Commit: finalExec.Commit.Commit,
	}, nil); code != 200 {
		t.Fatalf("branch side failed: %d", code)
	}
	_ = doJSON(t, "POST", base+"/v1/lineages/lin_e2e/write", fullTok, repo.WriteRequest{
		Ref:  "refs/heads/main",
		Puts: []repo.WritePut{{Path: "src/index.ts", Content: "console.log('main')\n"}},
	}, nil)
	_ = doJSON(t, "POST", base+"/v1/lineages/lin_e2e/write", fullTok, repo.WriteRequest{
		Ref:  "refs/heads/side",
		Puts: []repo.WritePut{{Path: "src/index.ts", Content: "console.log('side')\n"}},
	}, nil)

	var mergeConflictRes repo.MergeResponse
	if code := doJSON(t, "POST", base+"/v1/lineages/lin_e2e/merge", fullTok, repo.MergeRequest{
		SourceRef: "refs/heads/side",
		TargetRef: "refs/heads/main",
		Strategy:  "three-way",
	}, &mergeConflictRes); code != 409 || len(mergeConflictRes.Conflicts) != 1 || mergeConflictRes.Conflicts[0] != "src/index.ts" {
		t.Fatalf("expected 409 merge conflict on src/index.ts, got %d %+v", code, mergeConflictRes)
	}
}

func TestOutboundHostMuxRegistrationAndCommandDispatch(t *testing.T) {
	env := setupTestServer(t, true)
	base := env.srv.URL

	// 1. Register outbound compute host with --host-token
	var hbRes vm.HostHeartbeatResponse
	if code := doJSON(t, "POST", base+"/v1/hosts/heartbeat", env.hostToken, vm.HostHeartbeatRequest{
		HostID:      "host_compute_1",
		CapacityVMs: 8,
		RunningVMs:  0,
		Status:      "ready",
	}, &hbRes); code != 200 || !hbRes.OK {
		t.Fatalf("POST /v1/hosts/heartbeat failed: %d %+v", code, hbRes)
	}

	// Simulate an outbound host agent polling /v1/hosts/host_compute_1/commands and posting /results!
	stopAgent := make(chan struct{})
	defer close(stopAgent)

	go func() {
		filesOnHost := map[string]map[string]any{}
		for {
			select {
			case <-stopAgent:
				return
			default:
			}
			var cmds vm.HostCommandsResponse
			code := doJSON(t, "GET", base+"/v1/hosts/host_compute_1/commands?waitMs=200", env.hostToken, nil, &cmds)
			if code != 200 {
				return
			}
			for _, cmd := range cmds.Commands {
				switch cmd.Type {
				case "vm.start":
					var p struct {
						Files map[string]map[string]any `json:"files"`
					}
					_ = json.Unmarshal(cmd.Payload, &p)
					if p.Files != nil {
						filesOnHost = p.Files
					}
					_ = doJSON(t, "POST", base+"/v1/hosts/host_compute_1/results", env.hostToken, vm.HostResultRequest{
						CommandID: cmd.CommandID,
						VMID:      cmd.VMID,
						OK:        true,
						Done:      true,
					}, nil)
				case "vm.exec":
					// Stream a chunk first (done=false), mutate simulated workspace, then send final result (done=true).
					_ = doJSON(t, "POST", base+"/v1/hosts/host_compute_1/results", env.hostToken, vm.HostResultRequest{
						CommandID:   cmd.CommandID,
						VMID:        cmd.VMID,
						OK:          true,
						StdoutChunk: "remote-exec-ok\n",
						Done:        false,
					}, nil)
					filesOnHost["remote.txt"] = map[string]any{
						"mode":   420,
						"base64": base64.StdEncoding.EncodeToString([]byte("created-on-remote-host\n")),
					}
					resRaw, _ := json.Marshal(vm.DriverExecResult{
						ExitCode: 0,
						Stdout:   "remote-exec-ok\n",
						Stderr:   "",
						Cwd:      "/workspace",
					})
					_ = doJSON(t, "POST", base+"/v1/hosts/host_compute_1/results", env.hostToken, vm.HostResultRequest{
						CommandID: cmd.CommandID,
						VMID:      cmd.VMID,
						OK:        true,
						Done:      true,
						Result:    resRaw,
					}, nil)
				case "vm.snapshot":
					snapRaw, _ := json.Marshal(map[string]any{"files": filesOnHost})
					_ = doJSON(t, "POST", base+"/v1/hosts/host_compute_1/results", env.hostToken, vm.HostResultRequest{
						CommandID: cmd.CommandID,
						VMID:      cmd.VMID,
						OK:        true,
						Done:      true,
						Result:    snapRaw,
					}, nil)
				case "vm.stop":
					_ = doJSON(t, "POST", base+"/v1/hosts/host_compute_1/results", env.hostToken, vm.HostResultRequest{
						CommandID: cmd.CommandID,
						VMID:      cmd.VMID,
						OK:        true,
						Done:      true,
					}, nil)
				}
			}
		}
	}()

	// 2. Create lineage, boot VM (dispatched to host_compute_1), exec (dispatched & snapshotted), and verify commit!
	var lin repo.CreateLineageResponse
	if code := doJSON(t, "POST", base+"/v1/lineages", env.devToken, map[string]any{"lineage": "lin_remote"}, &lin); code != 200 {
		t.Fatalf("create lineage: %d", code)
	}

	var bootRes vm.BootVMResponse
	if code := doJSON(t, "POST", base+"/v1/vms", env.devToken, vm.BootVMRequest{
		Lineage: "lin_remote",
		Ref:     "refs/heads/main",
		Holder:  "agt_remote",
	}, &bootRes); code != 200 {
		t.Fatalf("boot remote VM failed: %d", code)
	}

	var execRes vm.ExecResponse
	if code := doJSON(t, "POST", fmt.Sprintf("%s/v1/vms/%s/exec", base, bootRes.VMID), env.devToken, vm.ExecRequest{
		ExecID:  "exec_rem_1",
		Command: "echo remote-exec-ok",
	}, &execRes); code != 200 {
		t.Fatalf("remote exec failed: %d", code)
	}
	if !execRes.Commit.Changed || len(execRes.Commit.FilesChanged) != 1 || execRes.Commit.FilesChanged[0] != "remote.txt" {
		t.Fatalf("expected remote.txt committed from remote host snapshot, got %+v", execRes)
	}

	var readRem repo.ReadResponse
	if code := doJSON(t, "GET", base+"/v1/lineages/lin_remote/read?at=refs/heads/main&path=remote.txt", env.devToken, nil, &readRem); code != 200 || *readRem.Content != "created-on-remote-host\n" {
		t.Fatalf("expected remote.txt readable in repo, got %d %+v", code, readRem)
	}

	var stopRes vm.StopVMResponse
	if code := doJSON(t, "POST", fmt.Sprintf("%s/v1/vms/%s/stop", base, bootRes.VMID), env.devToken, map[string]any{}, &stopRes); code != 200 || stopRes.State != "stopped" {
		t.Fatalf("remote stop failed: %d %+v", code, stopRes)
	}
}
