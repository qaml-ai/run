package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/auth"
	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/delivery"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type guestObjects struct {
	store.Store
	manifests map[string][]byte
	reads     int
}

func (g *guestObjects) Get(_ context.Context, key string) ([]byte, error) {
	g.reads++
	if body, ok := g.manifests[key]; ok {
		return body, nil
	}
	return nil, os.ErrNotExist
}

func vmRequest(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer test")
	return r
}

func vmTestServer(c *compute.Controller, images []string, idle map[string]int64) *StorageServer {
	s := NewStorageServer(nil, "test", nil)
	s.authorize = func(w http.ResponseWriter, r *http.Request) *http.Request {
		if r.Header.Get("Authorization") == "" {
			authFail(w, 401, "unauthorized", "bearer token required")
			return nil
		}
		claims := auth.Claims{Subject: "runtime:agent", Lineage: "tenant", Access: "w", Refs: []string{"branch/*"}}
		for _, field := range []struct {
			header string
			dest   *string
		}{{"X-Subject", &claims.Subject}, {"X-Lineage", &claims.Lineage}, {"X-Access", &claims.Access}} {
			if value := r.Header.Get(field.header); value != "" {
				*field.dest = value
			}
		}
		return r.WithContext(context.WithValue(r.Context(), claimsKey{}, claims))
	}
	s.EnableCompute(c, images, []string{"build", "other"}, idle, 10*time.Second)
	return s
}

func vmTestBody(image string, deadline int64) string {
	return fmt.Sprintf(`{"id":"vm","lineage":"tenant","ref":"branch/main","image":%q,"shape":{"vcpus":1,"memoryMiB":1024,"diskGiB":2},"pool":"build","network":{"internet":false},"usage":{"payer":"p"},"deadline":%d}`, image, deadline)
}

func TestUnitVMValidation(t *testing.T) {
	now := time.Now()
	sha, unknown, corrupt := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)
	objects := &guestObjects{manifests: map[string][]byte{
		"guest/" + sha + ".json":     []byte(fmt.Sprintf(`{"sha256":%q,"bytes":1073741825}`, sha)),
		"guest/" + corrupt + ".json": []byte(fmt.Sprintf(`{"sha256":%q,"bytes":1}`, sha)),
	}}
	s := vmTestServer(&compute.Controller{Now: func() time.Time { return now }, Objects: objects}, []string{sha, unknown, corrupt}, nil)
	body := vmTestBody(sha, now.Add(time.Minute).UnixMilli())
	for _, tc := range []struct {
		name, old, replacement, header, value, message string
		status                                         int
	}{
		{name: "allowlist", old: sha, replacement: "wrong", message: "image wrong is not allowed", status: 400},
		{name: "missing manifest", old: sha, replacement: unknown, message: "unknown image " + unknown, status: 400},
		{name: "corrupt manifest", old: sha, replacement: corrupt, message: "internal", status: 500},
		{name: "disk", old: `"diskGiB":2`, replacement: `"diskGiB":1`, message: fmt.Sprintf("shape.diskGiB (1.0 GiB) is smaller than image %s (1.1 GiB)", sha), status: 400},
		{name: "deadline", old: strconv.FormatInt(now.Add(time.Minute).UnixMilli(), 10), replacement: strconv.FormatInt(now.Add(25*time.Hour).UnixMilli(), 10), message: "deadline", status: 400},
		{name: "mode", old: `{"id"`, replacement: `{"mode":"job","id"`, message: "unknown field mode", status: 400},
		{name: "job", old: `{"id"`, replacement: `{"job":{},"id"`, message: "unknown field job", status: 400},
		{name: "id", old: `"vm"`, replacement: `"a/b"`, message: "id:", status: 400},
		{name: "old session field", old: `{"id"`, replacement: `{"session":{"idleStopS":4},"id"`, message: "unknown field session", status: 400},
		{name: "idle zero", old: `{"id"`, replacement: `{"idleStopS":0,"id"`, message: "idleStopS", status: 400},
		{name: "idle null", old: `{"id"`, replacement: `{"idleStopS":null,"id"`, message: "idleStopS", status: 400},
		{name: "idle too long", old: `{"id"`, replacement: `{"idleStopS":3601,"id"`, message: "idleStopS", status: 400},
		{name: "payer", old: `"payer":"p"`, replacement: `"payer":""`, message: "usage.payer", status: 400},
		{name: "subject", header: "X-Subject", value: "agent:a", message: "forbidden", status: 403},
		{name: "lineage", header: "X-Lineage", value: "elsewhere", message: "forbidden", status: 403},
		{name: "access", header: "X-Access", value: "r", message: "forbidden", status: 403},
		{name: "ref", old: `"branch/main"`, replacement: `"main"`, message: "forbidden", status: 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := vmRequest("POST", "/v1/vms", strings.Replace(body, tc.old, tc.replacement, 1))
			if tc.header != "" {
				r.Header.Set(tc.header, tc.value)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.message) {
				t.Fatalf("got %d %s, want %d %s", w.Code, w.Body.String(), tc.status, tc.message)
			}
		})
	}
	if objects.reads != 3 {
		t.Fatalf("object reads = %d, want one per referenced allowed SHA", objects.reads)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, vmRequest("GET", "/v1/usage", ""))
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}

func TestUnitVMStatus(t *testing.T) {
	start, end := int64(30), int64(40)
	vm := compute.VM{
		CreateRequest: compute.CreateRequest{ID: "vm", Ref: "main", Version: "mounted", Session: &compute.Session{IdleStopS: 10}},
		Phase:         compute.Ended, Host: "host", RefLeaseEpoch: 9, RefLeaseDeadline: 50, LeaseDeadline: 60,
		Code: compute.Idle, StartedAt: &start, EndedAt: &end, StopRequestedAt: &end, LastActivityAt: &start,
		LastCheckpoint: &compute.Checkpoint{Version: "saved", Tree: "tree", At: 35},
	}
	body, err := json.Marshal(vmStatus(vm))
	want := `{"code":"idle","endedAt":40,"host":"host","id":"vm","lastCheckpoint":{"version":"saved","tree":"tree","at":35},"lease":{"deadline":50,"epoch":9},"phase":"ended","ref":"main","startedAt":30,"version":"mounted"}`
	if err != nil || string(body) != want {
		t.Fatalf("VM status: %s, %v", body, err)
	}
	vm = compute.VM{Phase: compute.Requested}
	body, err = json.Marshal(vmStatus(vm))
	want = `{"host":"","id":"","lease":{"deadline":0,"epoch":0},"phase":"requested","ref":"","version":""}`
	if err != nil || string(body) != want {
		t.Fatalf("VM status: %s, %v", body, err)
	}
}

func TestDDBVMClientAPI(t *testing.T) {
	db, vms := hostTable(t, "id")
	_, hosts := hostTable(t, "pool", "host")
	_, deliveries := hostTable(t, "shard", "id")
	_, usage := hostTable(t, "shard", "ulid")
	now := time.Now().Truncate(time.Millisecond)
	sha := strings.Repeat("a", 64)
	objects := &guestObjects{manifests: map[string][]byte{"guest/" + sha + ".json": []byte(fmt.Sprintf(`{"sha256":%q,"bytes":1}`, sha))}}
	c := &compute.Controller{DB: db, Tables: compute.Tables{VMs: vms, Hosts: hosts, Deliveries: deliveries, Usage: usage}, Objects: objects,
		Now: func() time.Time { return now }, RuntimeURL: "https://runtime.example/ended"}
	c.EnableClockCheck()
	s := vmTestServer(c, []string{sha}, map[string]int64{"build": 42})
	call := func(method, path, body, subject string, status int, want string) string {
		t.Helper()
		r := vmRequest(method, path, body)
		r.Header.Set("X-Subject", subject)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != status || !strings.Contains(w.Body.String(), want) {
			t.Fatalf("%s %s: got %d %s, want %d %s", method, path, w.Code, w.Body.String(), status, want)
		}
		return w.Body.String()
	}
	ctx := t.Context()
	body := vmTestBody(sha, now.Add(time.Minute).UnixMilli())
	call("POST", "/v1/vms", body, "", 202, `"phase":"requested"`)
	call("POST", "/v1/vms", body, "", 202, `"phase":"requested"`)
	call("POST", "/v1/vms", strings.Replace(body, `"payer":"p"`, `"payer":"x"`, 1), "", 409, "conflict")
	checkIdle := func(id string, want int64) {
		t.Helper()
		vm, err := c.Get(ctx, id)
		if err != nil || vm.Session == nil || vm.Session.IdleStopS != want {
			t.Fatalf("idle stop for %s: %+v, %v, want %d", id, vm.Session, err, want)
		}
	}
	checkIdle("vm", 42)
	call("GET", "/v1/vms/missing", "", "", 404, "not_found")
	other := strings.Replace(strings.Replace(body, `"vm"`, `"extra"`, 1), `"build"`, `"other"`, 1)
	call("POST", "/v1/vms", other, "", 202, "requested")
	checkIdle("extra", compute.DefaultIdleStopS)
	override := strings.Replace(strings.Replace(body, `"vm"`, `"override"`, 1), `{"id"`, `{"idleStopS":1,"id"`, 1)
	call("POST", "/v1/vms", override, "", 202, "requested")
	checkIdle("override", 1)
	epoch, err := c.Register(ctx, compute.HostInfo{Host: "host", Pool: "build", BootID: "boot", Slots: 1, Shape: compute.Shape{MemoryMiB: 4096, VCPUs: 2, DiskGiB: 10}})
	if err != nil {
		t.Fatal(err)
	}
	// Keep the override VM out of the placement queue before the loop runs.
	call("POST", "/v1/vms/override/stop", `{"checkpoint":false}`, "", 202, "ended")
	loop := compute.Loop{C: c, Pools: func(context.Context) ([]string, error) { return []string{"build"}, nil }}
	if err := loop.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	call("GET", "/v1/vms/vm", "", "", 200, `"phase":"booting"`)
	if _, err := c.Started(ctx, "vm", "host", epoch, now); err != nil {
		t.Fatal(err)
	}
	call("GET", "/v1/vms/vm", "", "", 200, `"phase":"running"`)
	until := now.Add(2 * time.Minute)
	call("POST", "/v1/vms/vm/deadline", fmt.Sprintf(`{"deadline":%d}`, until.UnixMilli()), "", 200, strconv.FormatInt(until.UnixMilli(), 10))
	call("POST", "/v1/vms/vm/deadline", fmt.Sprintf(`{"deadline":%d}`, now.Add(time.Minute).UnixMilli()), "", 200, strconv.FormatInt(until.UnixMilli(), 10))
	now = now.Add(time.Minute)
	call("POST", "/v1/vms", body, "", 202, `"phase":"running"`)
	call("POST", "/v1/vms/extra/deadline", fmt.Sprintf(`{"deadline":%d}`, until.UnixMilli()), "", 409, `{"error":"lease_expired"}`)
	call("POST", "/v1/vms/vm/stop", `{"checkpoint":true}`, "", 202, "stopping")
	call("POST", "/v1/vms/vm/stop", `{"checkpoint":false}`, "", 202, "stopping")
	if _, err := c.End(ctx, "vm", compute.EndRequest{At: now, Code: compute.Stopped}); err != nil {
		t.Fatal(err)
	}
	call("GET", "/v1/vms/vm", "", "", 200, `"phase":"ended"`)
	call("POST", "/v1/vms/vm/deadline", fmt.Sprintf(`{"deadline":%d}`, until.UnixMilli()), "", 409, `{"error":"ended"}`)
	call("GET", "/v1/usage", "", "runtime:usage", 200, `"events":[]`)
	now = now.Add(21 * time.Second)
	call("GET", "/v1/usage", "", "runtime:usage", 200, `"eventId":"vm:0"`)

	// A storage event with extra fields and whitespace passes through intact.
	raw := `{ "type":"usage.storage", "eventId":"storage", "bytes":17 }`
	shard := delivery.Shard("storage")
	key := "00000000010000000000000000"
	_, err = db.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(usage), Item: map[string]types.AttributeValue{
		"shard": &types.AttributeValueMemberS{Value: shard}, "ulid": &types.AttributeValueMemberS{Value: key},
		"body": &types.AttributeValueMemberS{Value: raw},
	}})
	if err != nil {
		t.Fatal(err)
	}
	page := call("GET", "/v1/usage?limit=1", "", "runtime:usage", 200, raw)
	var result struct{ Cursor string }
	if err := json.Unmarshal([]byte(page), &result); err != nil || result.Cursor == "" {
		t.Fatal(page, err)
	}
	call("GET", "/v1/usage?limit=1&after="+result.Cursor, "", "runtime:usage", 200, `"eventId":"vm:0"`)
}
