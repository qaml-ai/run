package computehost

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/api"
	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/ddb/ddbtest"
	"github.com/qaml-ai/run/camelfsd/internal/hostcert"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestDDBHostTierContract(t *testing.T) {
	db, vms := contractTable(t, "id")
	_, hosts := contractTable(t, "pool", "host")
	_, deliveries := contractTable(t, "shard", "id")
	_, usage := contractTable(t, "shard", "ulid")
	_, refsTable := contractTable(t, "lineage", "name")
	_, lineages := contractTable(t, "lineage")
	ctx := t.Context()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}

	const hostID, pool, lineage, name = "i-0123456789abcdef0", "build", "tenant:repo", "heads/main"
	// Keep the tier clock behind wall time so poll's wall-clock timestamps advance
	// lastSeenAt deterministically, even when two calls complete in one millisecond.
	var millis atomic.Int64
	millis.Store(time.Now().Add(-time.Minute).UnixMilli())
	clock := func() time.Time { return time.UnixMilli(millis.Load()) }
	advance := func() int64 { return millis.Add(1000) }
	objectDB, err := refs.OpenStorage(filepath.Join(t.TempDir(), "objects.db"))
	must(err)
	t.Cleanup(func() { objectDB.Close() })
	backing := store.Local{Dir: t.TempDir()}
	repo := &objects.Repository{DB: objectDB, Store: backing, TempDir: t.TempDir()}
	refStore := refstore.New(db, refsTable, clock, nil)
	refStore.GuardLineages(lineages)
	controller := &compute.Controller{
		DB: db, Tables: compute.Tables{VMs: vms, Hosts: hosts, Deliveries: deliveries, Usage: usage},
		Now: clock, Refs: refStore, RuntimeURL: "https://runtime.example/ended", Objects: backing,
	}
	controller.EnableClockCheck()
	storage := api.NewStorageServer(repo, "test", nil)
	storage.ConfigureRefs(db, refsTable, lineages, clock)
	hostMux := api.NewHostServer(controller, []string{pool}, nil, 30*time.Second)
	hostMux.EnableCAS(storage.HostCAS)
	identity := contractIdentity(t, controller, hostMux, hostID, pool)

	shape := hostwire.Shape{VCPUs: 4, MemoryMiB: 4096, DiskMiB: 1024}
	data := t.TempDir()
	must(os.Mkdir(filepath.Join(data, "images"), 0700))
	h, err := Open(ctx, Config{Data: data, BootID: "initial", HostID: hostID, Pool: pool,
		Addr: "127.0.0.1:1234", Shape: shape, Slots: 2, Post: identity.Post})
	must(err)
	t.Cleanup(h.Close)
	getHost := func() compute.Host {
		t.Helper()
		row, err := controller.Host(ctx, pool, hostID)
		must(err)
		return row
	}

	must(h.register(ctx))
	registered := getHost()
	wantShape := compute.Shape{VCPUs: shape.VCPUs, MemoryMiB: shape.MemoryMiB, DiskMiB: shape.DiskMiB}
	if h.epoch != 1 || registered.BootEpoch != 1 || registered.Shape != wantShape || registered.Slots != h.Slots {
		t.Fatalf("registration: host epoch %d, tier row %+v", h.epoch, registered)
	}
	heartbeatAt := advance()
	must(h.poll(ctx))
	if got := getHost().LastSeenAt; got != heartbeatAt || got <= registered.LastSeenAt {
		t.Fatalf("heartbeat lastSeenAt = %d, registration lastSeenAt = %d", got, registered.LastSeenAt)
	}

	_, err = db.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(lineages), Item: map[string]types.AttributeValue{
		"lineage": &types.AttributeValueMemberS{Value: lineage},
	}})
	must(err)
	tree, err := repo.PutObject(ctx, lineage, "tree", nil)
	must(err)
	putCommit := func(parent, message string) string {
		t.Helper()
		raw := "tree " + tree + "\n"
		if parent != "" {
			raw += "parent " + parent + "\n"
		}
		raw += "author Test <test@example.com> 1000 +0000\ncommitter Test <test@example.com> 1000 +0000\n\n" + message + "\n"
		id, err := repo.PutObject(ctx, lineage, "commit", []byte(raw))
		must(err)
		return id
	}
	base := putCommit("", "base")
	must(refStore.Create(ctx, lineage, name, refstore.Target{Version: base, Tree: tree}, nil, nil))
	const vmID = "contract-vm"
	_, err = controller.Create(ctx, compute.CreateRequest{ID: vmID, Lineage: lineage, Ref: name, Pool: pool,
		Payer: "payer", Image: strings.Repeat("a", 64), Shape: compute.Shape{VCPUs: 1, MemoryMiB: 1024, DiskMiB: 256},
		Session: &compute.Session{IdleStopS: 600}, Deadline: clock().Add(20 * time.Minute)})
	must(err)
	_, err = controller.Place(ctx, vmID)
	must(err)
	vm, err := controller.MarkBooting(ctx, vmID)
	must(err)
	spec, err := vm.BootSpec()
	must(err)
	holder := hostwire.Holder{Host: hostID, Boot: 1, Mount: vmID}
	if spec.Lease.Holder != holder || spec.Lease.Epoch <= 0 || spec.Version != base {
		t.Fatalf("boot spec: %+v", spec)
	}
	getVM := func() compute.VM {
		t.Helper()
		row, err := controller.Get(ctx, vmID)
		must(err)
		return row
	}
	started := advance()
	must(h.reportStarted(ctx, spec.ID, spec.Lease.Holder.Boot, started))
	if got := getVM(); got.Phase != compute.Running || got.StartedAt == nil || *got.StartedAt != started {
		t.Fatalf("started: %+v", got)
	}

	commit := putCommit(base, "checkpoint")
	root := strings.Repeat("b", 64)
	r := record{Spec: spec, StartedAt: &started, Pending: &checkpointIntent{Commit: commit, Expect: base, Tree: tree, Root: root}}
	moved, err := h.cas(ctx, r, false)
	must(err)
	if moved.Version != commit || moved.Tree != tree || !moved.Changed {
		t.Fatalf("CAS reply: %+v", moved)
	}
	wantHead := func() {
		t.Helper()
		head, err := refStore.Get(ctx, lineage, name)
		must(err)
		if head.Target != (refstore.Target{Version: commit, Tree: tree, Root: root}) {
			t.Fatalf("DynamoDB ref: %+v", head)
		}
	}
	wantHead()

	wantRefusal := func(r record, status int, code string, details map[string]any) {
		t.Helper()
		_, err := h.cas(ctx, r, false)
		var tier *tierError
		if !errors.As(err, &tier) || tier.Status != status || tier.Code != code {
			t.Fatalf("CAS refusal: got %v, want HTTP %d %s", err, status, code)
		}
		if details != nil {
			var envelope errorEnvelope
			must(json.Unmarshal(tier.Body, &envelope))
			var actual map[string]any
			must(json.Unmarshal(envelope.Error.Details, &actual))
			if !reflect.DeepEqual(actual, details) {
				t.Fatalf("CAS refusal details: got %v, want %v", actual, details)
			}
		}
		wantHead()
	}
	nextCommit := putCommit(commit, "next checkpoint")
	r.Pending = &checkpointIntent{Commit: nextCommit, Expect: base, Tree: tree, Root: root}
	wantRefusal(r, 412, "stale", map[string]any{"current": commit})
	r.Pending.Expect = commit
	wrongEpoch := r
	wrongEpoch.Spec.Lease.Epoch++
	wantRefusal(wrongEpoch, 409, "fenced", map[string]any{"holder": holder.String(), "epoch": float64(spec.Lease.Epoch)})

	// Finish on boot 1 while the tier can still accept its ended callback.
	r.Ended = &hostwire.Ended{BootEpoch: spec.Lease.Holder.Boot, At: advance(), Code: "stopped", Version: commit}
	s := &session{}
	must(h.save(s, r))
	h.vms[vmID] = s
	must(h.poll(ctx))
	if got := getVM(); got.Phase != compute.Ended || got.EndedAt == nil || *got.EndedAt != r.Ended.At ||
		got.Code != compute.Stopped || got.EndVersion != commit || !got.RefLeaseReleased || h.vms[vmID] != nil {
		t.Fatalf("ended: %+v, host still has record: %t", got, h.vms[vmID] != nil)
	}

	// Keep a boot-1 lease independent of the ended VM's reservation. Its epoch
	// matches the request, so forwarding the body holder would let the CAS through.
	oldLease, err := refStore.Acquire(ctx, lineage, name, holder.String(), 60_000)
	must(err)
	r.Spec.Lease.Epoch = oldLease.Epoch
	h.BootID = "reboot"
	must(h.register(ctx))
	if row := getHost(); h.epoch != 2 || row.BootEpoch != 2 || row.BootID != h.BootID {
		t.Fatalf("re-registration: host epoch %d, tier row %+v", h.epoch, row)
	}
	wantRefusal(r, 409, "fenced", map[string]any{"holder": holder.String(), "epoch": float64(oldLease.Epoch)})
	foreign := r
	foreign.Spec.Lease.Holder.Host = "other-host"
	wantRefusal(foreign, 403, "forbidden", nil)

	before := identity.current.Load().server.Certificates[0].Leaf
	must(identity.issue(ctx, false))
	after := identity.current.Load().server.Certificates[0].Leaf
	if before.SerialNumber.Cmp(after.SerialNumber) == 0 {
		t.Fatal("renewal did not install a new certificate")
	}
	heartbeatAt = advance()
	must(h.poll(ctx))
	if got := getHost().LastSeenAt; got != heartbeatAt {
		t.Fatalf("heartbeat after renewal: lastSeenAt = %d, want %d", got, heartbeatAt)
	}
}

func contractTable(t *testing.T, keys ...string) (*dynamodb.Client, string) {
	t.Helper()
	var schema ddbtest.Schema
	kinds := []types.KeyType{types.KeyTypeHash, types.KeyTypeRange}
	for i, key := range keys {
		schema.Keys = append(schema.Keys, types.KeySchemaElement{AttributeName: aws.String(key), KeyType: kinds[i]})
		schema.Attributes = append(schema.Attributes, types.AttributeDefinition{AttributeName: aws.String(key), AttributeType: types.ScalarAttributeTypeS})
	}
	return ddbtest.Table(t, schema)
}

func contractIdentity(t *testing.T, controller *compute.Controller, hostMux *api.HostServer, hostID, pool string) *Identity {
	t.Helper()
	ca := makeCA(t)
	pair := ca.pair(t, hostcert.TierURI)
	key, err := x509.MarshalPKCS8PrivateKey(pair.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	writePEM := func(name, kind string, der []byte) string {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}), 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	tierTLS, err := api.LoadHostTLS(writePEM("ca.pem", "CERTIFICATE", ca.leaf.Raw),
		writePEM("tier.pem", "CERTIFICATE", pair.Certificate[0]), writePEM("tier-key.pem", "PRIVATE KEY", key))
	if err != nil {
		t.Fatal(err)
	}
	issuer := &contractIssuer{t: t, ca: ca}
	issuer.serial.Store(2)
	certs := api.HostCertificates{Issuer: issuer, TLS: tierTLS}
	hostMux.EnableRenewal(certs)
	tier := httptest.NewUnstartedServer(hostMux)
	tier.TLS = tierTLS.ServerConfig()
	tier.StartTLS()
	t.Cleanup(tier.Close)

	// Use the real enrollment server and DDB replay recording. A local STS
	// response stands in for AWS attestation verification.
	const audience = "host-contract"
	const audienceHeader = "x-camelrun-job-host-audience"
	roles, err := api.ParseEnrollmentRoles(pool+"=arn:aws:iam::123456789012:role/host", []string{pool})
	if err != nil {
		t.Fatal(err)
	}
	enroll := httptest.NewUnstartedServer(api.EnrollmentServer{
		Audience: audience, Roles: roles, STS: contractSTS{hostID}, Record: controller.RecordEnrollment, Certificates: certs,
	})
	enroll.TLS = tierTLS.EnrollServerConfig()
	enroll.StartTLS()
	t.Cleanup(enroll.Close)
	attest := func(context.Context) (attestation, error) {
		return attestation{Kind: "aws", Method: http.MethodPost, URL: "https://sts.amazonaws.com/",
			Body: "Action=GetCallerIdentity&Version=2011-06-15",
			Headers: map[string]string{
				"Host": "sts.amazonaws.com", "X-Amz-Date": time.Now().UTC().Format("20060102T150405Z"),
				audienceHeader:  audience,
				"Authorization": "AWS4-HMAC-SHA256 SignedHeaders=host;x-amz-date;" + audienceHeader + ", Signature=test",
			}}, nil
	}
	identity, err := NewIdentity(t.Context(), t.TempDir(), hostID, pool, tier.Listener.Addr().String(), enroll.URL, pinCA(t, ca), attest)
	if err != nil {
		t.Fatal(err)
	}
	return identity
}

type contractSTS struct{ hostID string }

func (s contractSTS) Do(context.Context, string, map[string]string, string) (int, []byte, error) {
	return http.StatusOK, []byte("<Arn>arn:aws:sts::123456789012:assumed-role/host/" + s.hostID + "</Arn>"), nil
}

type contractIssuer struct {
	t      *testing.T
	ca     testCA
	serial atomic.Int64
}

func (i *contractIssuer) Issue(_ context.Context, csrDER []byte, uri string, _ time.Duration, _ bool) (string, string, time.Time, error) {
	csr, err := x509.ParseCertificateRequest(csrDER)
	if err != nil {
		return "", "", time.Time{}, err
	}
	raw := i.ca.issue(i.t, uri, i.serial.Add(1), csr.PublicKey)
	leaf, err := x509.ParseCertificate(raw)
	if err != nil {
		return "", "", time.Time{}, err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw})), "", leaf.NotAfter, nil
}

func (i *contractIssuer) CACertificate(context.Context) (string, error) {
	return i.ca.pem, nil
}
