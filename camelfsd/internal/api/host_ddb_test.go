package api

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/ddb/ddbtest"
	"github.com/qaml-ai/run/camelfsd/internal/delivery"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func hostTable(t *testing.T, keys ...string) (*dynamodb.Client, string) {
	t.Helper()
	schema := ddbtest.Schema{}
	kinds := []types.KeyType{types.KeyTypeHash, types.KeyTypeRange}
	for i, key := range keys {
		schema.Keys = append(schema.Keys, types.KeySchemaElement{AttributeName: aws.String(key), KeyType: kinds[i]})
		schema.Attributes = append(schema.Attributes, types.AttributeDefinition{AttributeName: aws.String(key), AttributeType: types.ScalarAttributeTypeS})
	}
	return ddbtest.Table(t, schema)
}

func TestDDBHostChannel(t *testing.T) {
	db, vms := hostTable(t, "id")
	_, hosts := hostTable(t, "pool", "host")
	_, deliveries := hostTable(t, "shard", "id")
	_, usage := hostTable(t, "shard", "ulid")
	_, refs := hostTable(t, "lineage", "name")
	ctx := t.Context()
	now := time.Unix(1_800_000_000, 0)
	clock := func() time.Time { return now }
	objects := store.Local{Dir: t.TempDir()}
	ca := newHostTestCA(t)
	credentials := testHostTLS(t, ca, ca.leaf(t, x509.ExtKeyUsageClientAuth, "spiffe://camelfs/tier"), t.TempDir())
	pusher := HostPusher{TLS: credentials}
	c := &compute.Controller{DB: db, Tables: compute.Tables{VMs: vms, Hosts: hosts, Deliveries: deliveries, Usage: usage},
		Now: clock, Refs: refstore.New(db, refs, clock, nil), Pusher: pusher, RuntimeURL: "https://runtime.example/ended", Objects: objects}
	pools := []string{"pool"}
	loop := compute.Loop{C: c, Pools: func(context.Context) ([]string, error) { return pools, nil }}
	server := NewHostServer(c, pools, 30*time.Second)
	tier := testTier(t, credentials, server)
	var mu sync.Mutex
	var boots []hostwire.BootSpec
	var stops []hostwire.Stop
	host := fakeHostTLS(t, ca, ca.leaf(t, x509.ExtKeyUsageServerAuth, hostSANPrefix+"a"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path == "/v1/vms" {
			var q hostwire.BootSpec
			if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
				t.Error(err)
			}
			v, err := c.Get(r.Context(), q.ID)
			if err != nil || v.Phase != compute.Booting {
				t.Errorf("boot before commit: %+v, %v", v, err)
			}
			ref, err := c.Refs.Get(r.Context(), q.Lineage, q.Ref)
			if err != nil || ref.Holder == nil || *ref.Holder != q.Lease.Holder.String() || ref.LeaseEpoch != q.Lease.Epoch {
				t.Errorf("boot before fence: %+v, %v", ref, err)
			}
			boots = append(boots, q)
		} else {
			var q hostwire.Stop
			if err := json.NewDecoder(r.Body).Decode(&q); err != nil {
				t.Error(err)
			}
			stops = append(stops, q)
		}
		w.WriteHeader(204)
	}))
	clientA := testHostClient(t, ca.pool, ca.leaf(t, x509.ExtKeyUsageClientAuth, hostSANPrefix+"a"))
	clientB := testHostClient(t, ca.pool, ca.leaf(t, x509.ExtKeyUsageClientAuth, hostSANPrefix+"b"))
	post := func(client *http.Client, path string, q any, want int, reply any) string {
		t.Helper()
		raw, err := json.Marshal(q)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(ctx, "POST", tier.URL+"/v1/hosts/"+path, bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil || resp.StatusCode != want {
			t.Fatalf("%s: HTTP %d, %s, %v", path, resp.StatusCode, body, err)
		}
		if reply != nil {
			if err := json.Unmarshal(body, reply); err != nil {
				t.Fatal(err)
			}
		}
		return string(body)
	}
	image, commit, tree := strings.Repeat("a", 64), strings.Repeat("b", 40), strings.Repeat("c", 40)
	register := hostwire.Register{Pool: "pool", BootID: "initial", Addr: host.Listener.Addr().String(),
		Shape: hostwire.Shape{VCPUs: 4, MemoryMiB: 4096, DiskMiB: 1024}, Slots: 1, Images: []string{image}}
	var registered hostwire.Registered
	post(clientA, "a/register", register, 200, &registered)
	post(clientB, "b/register", register, 200, nil)
	heartbeat := func(epoch int64, free int, running ...hostwire.Running) hostwire.HeartbeatReply {
		t.Helper()
		var reply hostwire.HeartbeatReply
		post(clientA, "a/heartbeat", hostwire.Heartbeat{BootEpoch: epoch, At: now.UnixMilli(), Free: free, Running: running}, 200, &reply)
		return reply
	}
	heartbeat(registered.BootEpoch, 1)
	lin := "tenant:repo"
	if err := c.Refs.Create(ctx, lin, "main", refstore.Target{Version: commit, Tree: tree}, nil, nil); err != nil {
		t.Fatal(err)
	}
	create := func(id string) {
		t.Helper()
		_, err := c.Create(ctx, compute.CreateRequest{ID: id, Lineage: lin, Ref: "main", Pool: "pool", Payer: "payer", Image: image,
			Mode: compute.JobMode, Job: &compute.Job{Command: "true", TimeoutS: 600, Pids: 32}, Internet: true,
			Shape: compute.Shape{VCPUs: 1, MemoryMiB: 1024, DiskMiB: 256}, Deadline: now.Add(20 * time.Minute)})
		if err != nil {
			t.Fatal(err)
		}
	}
	pass := func() {
		t.Helper()
		if err := loop.Pass(ctx); err != nil {
			t.Fatal(err)
		}
	}
	get := func(id string) compute.VM {
		t.Helper()
		v, err := c.Get(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}

	create("life")
	pass()
	mu.Lock()
	gotBoots := append([]hostwire.BootSpec(nil), boots...)
	mu.Unlock()
	if len(gotBoots) != 1 || gotBoots[0].ID != "life" || gotBoots[0].Image != image || gotBoots[0].Parent != commit ||
		gotBoots[0].Version != commit || gotBoots[0].Tree != tree || gotBoots[0].Job.Pids != 32 || !gotBoots[0].Internet {
		t.Fatalf("boot specs: %+v", gotBoots)
	}
	start := hostwire.Started{BootEpoch: 1, At: now.UnixMilli()}
	post(clientB, "b/vms/life/started", start, 409, nil)
	post(clientA, "a/vms/life/started", start, 204, nil)
	for range 4 {
		now = now.Add(time.Minute)
		heartbeat(1, 0, hostwire.Running{ID: "life", StartedAt: &start.At})
	}
	oldFence := gotBoots[0].Lease
	pass()
	v := get("life")
	if v.UsageSeq != 4 || v.RefLeaseEpoch != oldFence.Epoch || v.RefLeaseDeadline <= oldFence.Deadline {
		t.Fatalf("usage or renewal: %+v", v)
	}
	if _, err := c.RequestStop(ctx, "life", true); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	gotStops := append([]hostwire.Stop(nil), stops...)
	mu.Unlock()
	if len(gotStops) != 1 || !gotStops[0].Checkpoint {
		t.Fatal(gotStops)
	}
	if reply := heartbeat(1, 0, hostwire.Running{ID: "life"}); len(reply.Stop) != 1 || reply.Stop[0] != "life" {
		t.Fatal(reply)
	}
	body := []byte(`{"exit":0}`)
	key, _ := store.ResultKey(lin, "life")
	end := hostwire.Ended{BootEpoch: 1, At: now.UnixMilli(), Code: "stopped", ResultKey: key, ResultBytes: int64(len(body)), ResultSha256: root.Hash(body)}
	path := "a/vms/life/ended"
	post(clientB, "b/vms/life/ended", end, 409, nil)
	q := end
	q.ResultKey = lin + "/results/life"
	post(clientA, path, q, 400, nil)
	if resp := post(clientA, path, end, 409, nil); !strings.Contains(resp, "result not found") {
		t.Fatal(resp)
	}
	if err := store.Atomic(filepath.Join(objects.Dir, key), body); err != nil {
		t.Fatal(err)
	}
	q = end
	q.ResultBytes++
	post(clientA, path, q, 409, nil)

	// Fail after HEAD succeeds and before End is attempted.
	server.headResult = func(ctx context.Context, key string) (store.Info, error) {
		info, err := objects.Head(ctx, key)
		if err != nil {
			return info, err
		}
		return info, errors.New("injected interruption after HEAD")
	}
	post(clientA, path, end, 500, nil)
	if v := get("life"); v.Phase != compute.Stopping {
		t.Fatal(v)
	}
	server.headResult = objects.Head
	post(clientA, path, end, 204, nil)
	post(clientA, path, end, 204, nil)
	v = get("life")
	if v.Phase != compute.Ended || !v.RefLeaseReleased || v.ResultRef != key || v.ResultSha256 != end.ResultSha256 || v.ResultBytes != end.ResultBytes || v.UsageSeq != 5 {
		t.Fatalf("ended: %+v", v)
	}
	h, err := c.Host(ctx, "pool", "a")
	if err != nil || h.Free != 1 || h.FreeMiB != 4096 || len(h.VMs) != 0 {
		t.Fatalf("capacity: %+v, %v", h, err)
	}
	deliveryID := "vm.ended:life"
	row, err := db.GetItem(ctx, &dynamodb.GetItemInput{TableName: &deliveries, ConsistentRead: aws.Bool(true), Key: map[string]types.AttributeValue{
		"shard": &types.AttributeValueMemberS{Value: delivery.Shard(deliveryID)}, "id": &types.AttributeValueMemberS{Value: deliveryID},
	}})
	if err != nil || len(row.Item) == 0 {
		t.Fatalf("delivery: %+v, %v", row, err)
	}
	event := row.Item["body"].(*types.AttributeValueMemberB).Value
	if !bytes.Contains(event, []byte(end.ResultSha256)) || !bytes.Contains(event, []byte(key)) {
		t.Fatal(string(event))
	}

	read := func(want error) {
		t.Helper()
		stream, size, err := c.ReadResult(ctx, "life")
		if err != nil || size != int64(len(body)) {
			t.Fatalf("read: %d, %v", size, err)
		}
		defer stream.Close()
		got, err := io.ReadAll(stream)
		if !errors.Is(err, want) || want == nil && !bytes.Equal(got, body) {
			t.Fatalf("result: %q, %v", got, err)
		}
	}
	read(nil)
	if err := store.Atomic(filepath.Join(objects.Dir, key), []byte(`{"exit":1}`)); err != nil {
		t.Fatal(err)
	}
	read(compute.ErrResultCorrupt)

	host.Close()
	create("fallback")
	pass()
	if v := get("fallback"); v.Phase != compute.Booting {
		t.Fatal(v)
	}
	reply := heartbeat(1, 0)
	if len(reply.Boot) != 1 || reply.Boot[0].ID != "fallback" {
		t.Fatal(reply)
	}
	post(clientA, "a/vms/fallback/started", hostwire.Started{BootEpoch: 1, At: now.UnixMilli()}, 204, nil)
	if reply := heartbeat(1, 0, hostwire.Running{ID: "fallback"}); len(reply.Boot) != 0 {
		t.Fatal(reply)
	}

	if got := post(clientA, "a/heartbeat", hostwire.Heartbeat{BootEpoch: 0}, 409, nil); !strings.Contains(got, "stale_epoch") {
		t.Fatal(got)
	}
	register.BootID = "reboot"
	post(clientA, "a/register", register, 200, &registered)
	if registered.BootEpoch != 2 || get("fallback").Code != compute.HostLost {
		t.Fatal(registered, get("fallback"))
	}
	post(clientA, "a/heartbeat", hostwire.Heartbeat{BootEpoch: 1}, 409, nil)
}

func TestDDBHostEnrollmentReplay(t *testing.T) {
	db, hosts := hostTable(t, "pool", "host")
	now := time.Now()
	clock := func() time.Time { return now }
	c := &compute.Controller{DB: db, Tables: compute.Tables{Hosts: hosts}, Now: clock}
	server, _ := enrollmentServer(t, clock)
	server.Record = c.RecordEnrollment
	loop := compute.Loop{C: c, Enrollment: true, Pools: func(context.Context) ([]string, error) {
		return []string{"build"}, nil
	}}
	a := attestationAt(now)
	csr, _ := enrollCSR(t, hostSANPrefix+enrollmentHost, nil, false)
	for _, want := range []int{200, 409} {
		w := postEnrollment(t, server, a, csr, "build")
		if w.Code != want {
			t.Fatalf("want %d, got %d: %s", want, w.Code, w.Body)
		}
	}
	checked, _ := checkAwsAttestation(a, enrollmentAudience, now)
	key := map[string]types.AttributeValue{"pool": &types.AttributeValueMemberS{Value: "build"},
		"host": &types.AttributeValueMemberS{Value: "~enroll#" + checked.signature}}
	for _, elapsed := range []time.Duration{14 * time.Minute, 2 * time.Minute} {
		now = now.Add(elapsed)
		if err := loop.Pass(t.Context()); err != nil {
			t.Fatal(err)
		}
		row, err := db.GetItem(t.Context(), &dynamodb.GetItemInput{TableName: &hosts, Key: key, ConsistentRead: aws.Bool(true)})
		if err != nil || (len(row.Item) == 0) != (elapsed == 2*time.Minute) {
			t.Fatalf("unexpected replay row after sweep: %v, %v", row, err)
		}
	}
	if w := postEnrollment(t, server, a, csr, "build"); w.Code != 401 {
		t.Fatalf("expired attestation: %d %s", w.Code, w.Body)
	}
}
