package api

import (
	"bufio"
	"context"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
)

func TestDDBVMSessionProxy(t *testing.T) {
	db, vms := hostTable(t, "id")
	_, hosts := hostTable(t, "pool", "host")
	_, usage := hostTable(t, "shard", "ulid")
	_, deliveries := hostTable(t, "shard", "id")
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	var clock atomic.Int64
	clock.Store(time.Now().UnixMilli())
	now := func() time.Time { return time.UnixMilli(clock.Load()) }
	ca := newHostTestCA(t)
	credentials := testHostTLS(t, ca, ca.leaf(t, x509.ExtKeyUsageClientAuth, "spiffe://camelfs/tier"), t.TempDir())
	c := &compute.Controller{
		DB: db, Tables: compute.Tables{VMs: vms, Hosts: hosts, Usage: usage, Deliveries: deliveries},
		Now: now, Pusher: HostPusher{TLS: credentials}, RuntimeURL: "https://runtime.example/ended",
		HostFresh: 10 * time.Minute,
	}
	c.EnableClockCheck()
	const vmPath = "/v1/vms/vm"
	exitAllowed := make(chan struct{})
	checkpointEntered, checkpointAllowed := make(chan struct{}), make(chan struct{})
	stops := make(chan bool, 1)
	var mu sync.Mutex
	executions := map[string]string{}
	busy := false
	var checkpoints atomic.Int32
	host := fakeHostTLS(t, ca, ca.leaf(t, x509.ExtKeyUsageServerAuth, hostSANPrefix+"a"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("forwarded client authorization")
		}
		switch r.URL.Path {
		case vmPath + "/shells":
			jsonReply(w, 201, hostwire.ShellCreated{ShellID: "sh"})
		case vmPath + "/exec":
			var q hostwire.ExecRequest
			if err := json.NewDecoder(r.Body).Decode(&q); err != nil || q.Shell != "sh" {
				t.Errorf("exec request: %+v, %v", q, err)
				w.WriteHeader(400)
				return
			}
			mu.Lock()
			command, replay := executions[q.ExecID]
			switch {
			case replay && command != q.Command:
				mu.Unlock()
				authFail(w, 409, "exec_conflict", "conflict")
				return
			case !replay && busy:
				mu.Unlock()
				authFail(w, 409, "shell_busy", "busy")
				return
			case !replay:
				executions[q.ExecID] = q.Command
				busy = true
			}
			mu.Unlock()

			w.Header().Set("Content-Type", "text/event-stream")
			for i, frame := range sessionFrames {
				if q.ExecID == "disconnect" && i == 1 {
					select {
					case <-exitAllowed:
					case <-r.Context().Done():
						t.Error("client disconnect canceled host exec")
						return
					case <-ctx.Done():
						return
					}
				}
				if i == len(sessionFrames)-1 && !replay {
					mu.Lock()
					busy = false
					mu.Unlock()
				}
				fmt.Fprint(w, frame)
				w.(http.Flusher).Flush()
			}
		case vmPath + "/exec/e":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, strings.Join(sessionFrames[2:], ""))
		case vmPath + "/exec/old":
			if r.URL.RawQuery != "offset=2" {
				t.Errorf("tail query: %q", r.URL.RawQuery)
			}
			jsonReply(w, 410, map[string]any{"error": map[string]any{"code": "tail_truncated", "message": "tail truncated", "details": map[string]any{"firstOffset": 3}}})
		case vmPath + "/exec/missing":
			authFail(w, 404, "exec_unknown", "unknown")
		case vmPath + "/checkpoint":
			var q hostwire.CheckpointRequest
			if err := json.NewDecoder(r.Body).Decode(&q); err != nil || q.Time == nil || *q.Time != 88 {
				t.Errorf("checkpoint request: %+v, %v", q, err)
			}
			n := checkpoints.Add(1)
			if n == 1 {
				close(checkpointEntered)
				select {
				case <-checkpointAllowed:
				case <-ctx.Done():
					return
				}
			}
			if n == 3 {
				authFail(w, 409, "fenced", "fenced")
				return
			}
			jsonReply(w, 200, hostwire.CheckpointReply{
				Version: "saved", Tree: "tree", Diff: json.RawMessage(`[]`), Changed: n == 1 || n == 4,
			})
		case vmPath + "/stop":
			var q hostwire.Stop
			if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
				t.Error(err)
			}
			stops <- q.Checkpoint
			w.WriteHeader(204)
		default:
			t.Errorf("unexpected host route: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	// Cancel host test gates before httptest cleanup waits for active handlers.
	t.Cleanup(cancel)
	s := vmTestServer(c, nil, nil)
	request := func(method, suffix, body, access, subject string) *http.Request {
		r := vmRequest(method, vmPath+suffix, body).WithContext(ctx)
		r.Header.Set("X-Access", access)
		r.Header.Set("X-Subject", subject)
		return r
	}
	call := func(r *http.Request, status int, want string) string {
		t.Helper()
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != status || !strings.Contains(w.Body.String(), want) {
			t.Fatalf("%s %s: HTTP %d %s, want %d %s", r.Method, r.URL, w.Code, w.Body, status, want)
		}
		return w.Body.String()
	}
	post := func(suffix, body string) *http.Request { return request("POST", suffix, body, "", "") }
	get := func() compute.VM {
		t.Helper()
		v, err := c.Get(ctx, "vm")
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	check := func(_ compute.VM, err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	assertActivity := func() {
		t.Helper()
		if v := get(); v.LastActivityAt == nil || *v.LastActivityAt != clock.Load() {
			t.Fatalf("activity = %v, want %d", v.LastActivityAt, clock.Load())
		}
	}
	execBody := func(id, command string) string {
		return fmt.Sprintf(`{"execId":%q,"command":%q,"shell":"sh","timeoutS":120}`, id, command)
	}
	const save = `{"message":"save","trailers":{"kind":"manual"},"time":88}`
	shape := compute.Shape{VCPUs: 1, MemoryMiB: 1024, DiskGiB: 1}
	check(c.Create(ctx, compute.CreateRequest{ID: "vm", Lineage: "tenant", Ref: "branch/main",
		Pool: "build", Payer: "payer", Shape: shape, Session: &compute.Session{IdleStopS: 10},
		Deadline: now().Add(time.Hour)}))
	call(post("/shells", ""), 409, "not_running")
	epoch, err := c.Register(ctx, compute.HostInfo{Host: "a", Pool: "build", BootID: "boot",
		Addr: host.Listener.Addr().String(), Slots: 1, Shape: shape})
	if err != nil {
		t.Fatal(err)
	}
	check(c.Place(ctx, "vm"))
	check(c.MarkBooting(ctx, "vm"))
	check(c.Started(ctx, "vm", "a", epoch, now()))
	call(request("POST", "/shells", "", "w", "agent:a"), 403, "forbidden")
	call(post("/shells", ""), 201, `"shell":"sh"`)
	call(post("/exec", `{"command":"true","shell":"sh","timeoutS":1}`), 400, "execId")
	call(post("/exec", `{"execId":"e","command":"true","timeoutS":1}`), 400, "shell")
	call(post("/exec", execBody("e", "true")), 200, strings.Join(sessionFrames, ""))

	clock.Add(5_000)
	call(request("POST", "/exec", execBody("e", "true"), "w", "agent:a"), 200, strings.Join(sessionFrames, ""))
	assertActivity()
	call(post("/exec", execBody("e", "false")), 409, "exec_conflict")
	clock.Add(5_000)
	call(request("GET", "/exec/old?offset=2", "", "r", "agent:a"), 410, `"firstOffset":3`)
	assertActivity()
	call(request("GET", "/exec/e?offset=2", "", "r", "agent:a"), 200, strings.Join(sessionFrames[2:], ""))
	call(request("GET", "/exec/missing", "", "r", "agent:a"), 404, "exec_unknown")
	forbidden := request("GET", "/exec/missing", "", "r", "agent:a")
	forbidden.Header.Set("X-Lineage", "other")
	call(forbidden, 403, "forbidden")

	tier := httptest.NewServer(s)
	defer tier.Close()
	clientCtx, drop := context.WithCancel(ctx)
	defer drop()
	req, err := http.NewRequestWithContext(clientCtx, "POST", tier.URL+vmPath+"/exec", strings.NewReader(execBody("disconnect", "true")))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test")
	resp, err := tier.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if line, err := bufio.NewReader(resp.Body).ReadString('\n'); resp.StatusCode != 200 || err != nil || line != "event: stdout\r\n" {
		t.Fatalf("stream did not start: HTTP %d, %q, %v", resp.StatusCode, line, err)
	}
	drop()
	resp.Body.Close()
	call(post("/exec", execBody("busy", "true")), 409, "shell_busy")
	clock.Add(11_000)
	loop := compute.Loop{C: c, Pools: func(context.Context) ([]string, error) { return []string{"build"}, nil }}
	if err := loop.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	if v := get(); v.Phase != compute.Running {
		t.Fatalf("idle stopped active exec: %s", v.Phase)
	}

	first := httptest.NewRecorder()
	checkpointDone := make(chan struct{})
	go func() {
		s.ServeHTTP(first, post("/checkpoint", save))
		close(checkpointDone)
	}()
	awaitSessionSignal(t, ctx, checkpointEntered)
	call(post("/checkpoint", save), 409, "checkpoint_in_progress")
	close(checkpointAllowed)
	awaitSessionSignal(t, ctx, checkpointDone)
	if first.Code != 200 || !strings.Contains(first.Body.String(), `"changed":true`) {
		t.Fatalf("checkpoint: HTTP %d %s", first.Code, first.Body)
	}
	saved := get().LastCheckpoint
	if saved == nil || saved.Version != "saved" || saved.Tree != "tree" || saved.At != clock.Load() {
		t.Fatalf("lastCheckpoint: %+v", saved)
	}
	clock.Add(1_000)
	close(exitAllowed)
	for {
		if v := get(); v.LastActivityAt != nil && *v.LastActivityAt == clock.Load() {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("missing exit activity after disconnect")
		case <-time.After(10 * time.Millisecond):
		}
	}
	mu.Lock()
	runs := len(executions)
	mu.Unlock()
	if runs != 2 {
		t.Fatalf("host ran %d distinct commands, want 2", runs)
	}

	clock.Add(1_000)
	call(post("/checkpoint", save), 200, `"changed":false`)
	assertActivity()
	call(post("/checkpoint", save), 409, "fenced")
	if got := get().LastCheckpoint; got == nil || *got != *saved {
		t.Fatalf("no-op or fenced checkpoint overwrote lastCheckpoint: %+v", got)
	}
	_, err = db.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(vms), Key: map[string]types.AttributeValue{"id": &types.AttributeValueMemberS{Value: "vm"}},
		UpdateExpression: aws.String("SET checkpointing = :marker"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":marker": &types.AttributeValueMemberM{
			Value: map[string]types.AttributeValue{
				"owner": &types.AttributeValueMemberS{Value: "expired"},
				"at":    &types.AttributeValueMemberN{Value: fmt.Sprint(now().Add(-6 * time.Minute).UnixMilli())},
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	call(post("/checkpoint", save), 200, `"changed":true`)
	if got := get().LastCheckpoint; got == nil || got.At != clock.Load() {
		t.Fatalf("stale checkpoint did not complete: %+v", got)
	}
	clock.Add(11_000)
	if err := loop.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case checkpoint := <-stops:
		if !checkpoint {
			t.Fatal("idle stop omitted checkpoint")
		}
	case <-ctx.Done():
		t.Fatal("idle stop did not reach host")
	}
	callback := testTier(t, credentials, NewHostServer(c, []string{"build"}, 30*time.Second))
	hostClient := testHostClient(t, ca.pool, ca.leaf(t, x509.ExtKeyUsageClientAuth, hostSANPrefix+"a"))
	raw, err := json.Marshal(hostwire.Ended{BootEpoch: epoch, At: now().UnixMilli(), Code: string(compute.Stopped),
		Version: "idle-version", CheckpointError: "idle error"})
	if err != nil {
		t.Fatal(err)
	}
	ended, err := hostClient.Post(callback.URL+"/v1/hosts/a/vms/vm/ended", "application/json", strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	endedBody, err := io.ReadAll(ended.Body)
	ended.Body.Close()
	if err != nil || ended.StatusCode != 204 {
		t.Fatalf("ended callback: HTTP %d %s, %v", ended.StatusCode, endedBody, err)
	}
	if v := get(); v.Code != compute.Idle || v.EndVersion != "idle-version" || v.CheckpointError != "idle error" {
		t.Fatalf("idle end: %+v", v)
	}

	check(c.Create(ctx, compute.CreateRequest{ID: "other", Lineage: "tenant", Ref: "branch/main",
		Pool: "build", Payer: "payer", Shape: shape, Session: &compute.Session{IdleStopS: 10},
		Deadline: now().Add(time.Hour)}))
	check(c.Place(ctx, "other"))
	check(c.MarkBooting(ctx, "other"))
	check(c.Started(ctx, "other", "a", epoch, now()))
	host.Close()
	call(vmRequest("POST", "/v1/vms/other/exec", execBody("down", "true")), 502, "host_unreachable")
	clock.Add((11 * time.Minute).Milliseconds())
	call(vmRequest("POST", "/v1/vms/other/shells", ""), 409, "not_running")
}

func awaitSessionSignal(t *testing.T, ctx context.Context, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-ctx.Done():
		t.Fatal("timed out waiting for host proxy")
	}
}
