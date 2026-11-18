package aws_test

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/store"
	awsstore "github.com/qaml-ai/camelrun-next/camelfsd/internal/store/aws"
)

type memS3 struct {
	mu      sync.Mutex
	objects map[string][]byte
}

func newMemS3() *memS3 {
	return &memS3{objects: make(map[string][]byte)}
}

func (m *memS3) PutObject(_ context.Context, p *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	raw, err := io.ReadAll(p.Body)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.objects[*p.Bucket+"/"+*p.Key] = raw
	m.mu.Unlock()
	return &s3.PutObjectOutput{}, nil
}

func (m *memS3) GetObject(_ context.Context, p *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	m.mu.Lock()
	raw, ok := m.objects[*p.Bucket+"/"+*p.Key]
	m.mu.Unlock()
	if !ok {
		return nil, &s3types.NoSuchKey{}
	}
	return &s3.GetObjectOutput{Body: io.NopCloser(bytes.NewReader(raw))}, nil
}

func (m *memS3) HeadObject(_ context.Context, p *s3.HeadObjectInput, _ ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	m.mu.Lock()
	_, ok := m.objects[*p.Bucket+"/"+*p.Key]
	m.mu.Unlock()
	if !ok {
		return nil, &s3types.NotFound{}
	}
	return &s3.HeadObjectOutput{}, nil
}

type memDDB struct {
	mu     sync.Mutex
	tables map[string]map[string]map[string]ddbtypes.AttributeValue
}

func newMemDDB() *memDDB {
	return &memDDB{tables: make(map[string]map[string]map[string]ddbtypes.AttributeValue)}
}

func itemKey(item map[string]ddbtypes.AttributeValue) string {
	pk := item["PK"].(*ddbtypes.AttributeValueMemberS).Value
	sk := item["SK"].(*ddbtypes.AttributeValueMemberS).Value
	return pk + "\x00" + sk
}

func cloneItem(in map[string]ddbtypes.AttributeValue) map[string]ddbtypes.AttributeValue {
	if in == nil {
		return nil
	}
	out := make(map[string]ddbtypes.AttributeValue, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func (d *memDDB) tbl(name string) map[string]map[string]ddbtypes.AttributeValue {
	t, ok := d.tables[name]
	if !ok {
		t = make(map[string]map[string]ddbtypes.AttributeValue)
		d.tables[name] = t
	}
	return t
}

func (d *memDDB) GetItem(_ context.Context, p *dynamodb.GetItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	it := d.tbl(*p.TableName)[itemKey(p.Key)]
	return &dynamodb.GetItemOutput{Item: cloneItem(it)}, nil
}

func (d *memDDB) PutItem(_ context.Context, p *dynamodb.PutItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	t := d.tbl(*p.TableName)
	k := itemKey(p.Item)
	if p.ConditionExpression != nil && strings.Contains(*p.ConditionExpression, "attribute_not_exists") {
		if _, exists := t[k]; exists {
			return nil, &ddbtypes.ConditionalCheckFailedException{}
		}
	}
	t[k] = cloneItem(p.Item)
	return &dynamodb.PutItemOutput{}, nil
}

func (d *memDDB) UpdateItem(_ context.Context, p *dynamodb.UpdateItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	t := d.tbl(*p.TableName)
	k := itemKey(p.Key)
	cur, ok := t[k]
	if !ok {
		return nil, &ddbtypes.ConditionalCheckFailedException{}
	}
	next := cloneItem(cur)
	upd := *p.UpdateExpression
	switch {
	case strings.Contains(upd, "#c = :c"):
		next["commit"] = p.ExpressionAttributeValues[":c"]
		next["tree"] = p.ExpressionAttributeValues[":t"]
		next["updatedAt"] = p.ExpressionAttributeValues[":u"]
	case strings.Contains(upd, "leaseHolder = :empty"):
		next["leaseHolder"] = p.ExpressionAttributeValues[":empty"]
		next["leaseExpiresAt"] = p.ExpressionAttributeValues[":zero"]
	case strings.Contains(upd, "leaseEpoch = :newEpoch"):
		next["leaseHolder"] = p.ExpressionAttributeValues[":holder"]
		next["leaseEpoch"] = p.ExpressionAttributeValues[":newEpoch"]
		next["leaseExpiresAt"] = p.ExpressionAttributeValues[":exp"]
	}
	t[k] = next
	return &dynamodb.UpdateItemOutput{}, nil
}

func (d *memDDB) DeleteItem(_ context.Context, p *dynamodb.DeleteItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.tbl(*p.TableName), itemKey(p.Key))
	return &dynamodb.DeleteItemOutput{}, nil
}

func (d *memDDB) Query(_ context.Context, p *dynamodb.QueryInput, _ ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	pk := p.ExpressionAttributeValues[":pk"].(*ddbtypes.AttributeValueMemberS).Value
	skPrefix := ""
	if v, ok := p.ExpressionAttributeValues[":skPrefix"].(*ddbtypes.AttributeValueMemberS); ok {
		skPrefix = v.Value
	}
	var items []map[string]ddbtypes.AttributeValue
	for _, it := range d.tbl(*p.TableName) {
		itPK := it["PK"].(*ddbtypes.AttributeValueMemberS).Value
		itSK := it["SK"].(*ddbtypes.AttributeValueMemberS).Value
		if itPK == pk && strings.HasPrefix(itSK, skPrefix) {
			items = append(items, cloneItem(it))
		}
	}
	return &dynamodb.QueryOutput{Items: items}, nil
}

func (d *memDDB) Scan(_ context.Context, p *dynamodb.ScanInput, _ ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var items []map[string]ddbtypes.AttributeValue
	for _, it := range d.tbl(*p.TableName) {
		if it["SK"].(*ddbtypes.AttributeValueMemberS).Value == "META" {
			if st, ok := it["state"].(*ddbtypes.AttributeValueMemberS); ok && st.Value == "running" {
				items = append(items, cloneItem(it))
			}
		}
	}
	return &dynamodb.ScanOutput{Items: items}, nil
}

func (d *memDDB) TransactWriteItems(_ context.Context, p *dynamodb.TransactWriteItemsInput, _ ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, ti := range p.TransactItems {
		if ti.Put != nil && ti.Put.ConditionExpression != nil && strings.Contains(*ti.Put.ConditionExpression, "attribute_not_exists") {
			t := d.tbl(*ti.Put.TableName)
			if _, exists := t[itemKey(ti.Put.Item)]; exists {
				return nil, &ddbtypes.ConditionalCheckFailedException{}
			}
		}
	}
	for _, ti := range p.TransactItems {
		if del := ti.Delete; del != nil && del.ConditionExpression != nil {
			current := d.tbl(*del.TableName)[itemKey(del.Key)]
			if current != nil && *current["vmId"].(*ddbtypes.AttributeValueMemberS) != *del.ExpressionAttributeValues[":vmId"].(*ddbtypes.AttributeValueMemberS) {
				return nil, &ddbtypes.ConditionalCheckFailedException{}
			}
		}
	}
	for _, ti := range p.TransactItems {
		if ti.Put != nil {
			t := d.tbl(*ti.Put.TableName)
			t[itemKey(ti.Put.Item)] = cloneItem(ti.Put.Item)
		}
		if del := ti.Delete; del != nil {
			delete(d.tbl(*del.TableName), itemKey(del.Key))
		}
	}
	return &dynamodb.TransactWriteItemsOutput{}, nil
}

func TestAWSStoreTwoTableAndS3Backend(t *testing.T) {
	ctx := context.Background()
	st, err := awsstore.Open(ctx, awsstore.Config{
		Bucket:     "test-camelfs-objects",
		ReposTable: "camelfs-repos",
		VMsTable:   "camelfs-vms",
		DDB:        newMemDDB(),
		S3:         newMemS3(),
	})
	if err != nil {
		t.Fatalf("awsstore.Open: %v", err)
	}

	// S3 object roundtrip
	hash, err := st.PutObject(ctx, "lin_aws", store.KindBlob, []byte("hello from s3"))
	if err != nil {
		t.Fatalf("PutObject: %v", err)
	}
	kind, data, err := st.GetObject(ctx, hash)
	if err != nil || kind != store.KindBlob || string(data) != "hello from s3" {
		t.Fatalf("GetObject mismatch: kind=%s data=%q err=%v", kind, string(data), err)
	}

	nowMs := time.Now().UnixMilli()
	_, _, created, err := st.CreateLineageIfAbsent(
		ctx,
		store.LineageRecord{Lineage: "lin_aws", TenantID: "t1", DefaultRef: "refs/heads/main", CreatedAt: nowMs},
		store.RefRecord{Lineage: "lin_aws", Name: "refs/heads/main", Commit: "c1", Tree: "t1", UpdatedAt: nowMs},
	)
	if err != nil || !created {
		t.Fatalf("CreateLineageIfAbsent: created=%v err=%v", created, err)
	}

	// Lease + fencing
	lease, err := st.LeaseRef(ctx, store.LeaseRefParams{
		Lineage: "lin_aws",
		Ref:     "refs/heads/main",
		Holder:  "agt_1",
		TTLMs:   60_000,
		NowMs:   nowMs,
	})
	if err != nil || lease.Epoch != 1 {
		t.Fatalf("LeaseRef: %+v err=%v", lease, err)
	}
	if _, err := st.SetRef(ctx, store.SetRefParams{
		Lineage: "lin_aws",
		Ref:     "refs/heads/main",
		Commit:  "c2",
		Tree:    "t2",
		Holder:  "agt_other",
		NowMs:   nowMs + 10,
	}); !apperr.IsCode(err, apperr.CodeRefLeased) {
		t.Fatalf("expected ref_leased, got %v", err)
	}

	// Single running VM per (lineage, ref) enforced in camelfs-vms table
	vm1 := &store.VMRecord{
		VMID:           "vm_1",
		Lineage:        "lin_aws",
		Ref:            "refs/heads/main",
		Holder:         "agt_1",
		LeaseEpoch:     lease.Epoch,
		State:          "running",
		HeadCommit:     "c1",
		LeaseExpiresAt: nowMs + 60_000,
	}
	if err := st.CreateRunningVM(ctx, vm1); err != nil {
		t.Fatalf("CreateRunningVM 1: %v", err)
	}
	vm2 := *vm1
	vm2.VMID = "vm_2"
	if err := st.CreateRunningVM(ctx, &vm2); !apperr.IsCode(err, apperr.CodeRefLeased) {
		t.Fatalf("expected second running VM on same ref to fail with ref_leased, got %v", err)
	}

	// Exec receipt roundtrip
	if err := st.CompleteExec(ctx, store.CompleteExecParams{
		VM: vm1, BaseCommit: vm1.HeadCommit, Tree: "t1",
		Receipt: store.ExecReceipt{VMID: vm1.VMID, ExecID: "exec_1", ResponseJSON: []byte(`{"exitCode":0}`), CreatedAt: nowMs},
	}); err != nil {
		t.Fatalf("CompleteExec: %v", err)
	}
	// Recovery can replace the VM on a ref while retaining the previous VM's receipts.
	vm1.State = store.VMStateLost
	if err := st.UpdateVM(ctx, vm1); err != nil {
		t.Fatalf("retire lost VM: %v", err)
	}
	if err := st.CreateRunningVM(ctx, &vm2); err != nil {
		t.Fatalf("boot after retiring lost VM: %v", err)
	}
	if err := st.UpdateVM(ctx, vm1); err == nil {
		t.Fatal("retiring the old VM after replacement must not clear the active pointer")
	}
	current, err := st.GetRunningVMByRef(ctx, vm2.Lineage, vm2.Ref)
	if err != nil || current == nil || current.VMID != vm2.VMID {
		t.Fatalf("expected the replacement to remain active, got %+v err=%v", current, err)
	}

	rcpt, err := st.GetExecReceipt(ctx, "vm_1", "exec_1")
	if err != nil || rcpt == nil || string(rcpt.ResponseJSON) != `{"exitCode":0}` {
		t.Fatalf("GetExecReceipt mismatch: %+v err=%v", rcpt, err)
	}
}

func TestCompleteExecDynamoDBLocal(t *testing.T) {
	endpoint := os.Getenv("CAMELFS_DDB_LOCAL")
	if endpoint == "" {
		t.Skip("CAMELFS_DDB_LOCAL is unset")
	}
	ctx := t.Context()
	client := dynamodb.New(dynamodb.Options{
		BaseEndpoint: aws.String(endpoint), Region: "us-east-1",
		Credentials: credentials.NewStaticCredentialsProvider("localtest", "localtest", ""),
	})
	createTable := func(prefix string) string {
		t.Helper()
		name := store.RandomID(prefix)
		_, err := client.CreateTable(ctx, &dynamodb.CreateTableInput{
			TableName: aws.String(name), BillingMode: ddbtypes.BillingModePayPerRequest,
			AttributeDefinitions: []ddbtypes.AttributeDefinition{
				{AttributeName: aws.String("PK"), AttributeType: ddbtypes.ScalarAttributeTypeS},
				{AttributeName: aws.String("SK"), AttributeType: ddbtypes.ScalarAttributeTypeS},
			},
			KeySchema: []ddbtypes.KeySchemaElement{
				{AttributeName: aws.String("PK"), KeyType: ddbtypes.KeyTypeHash},
				{AttributeName: aws.String("SK"), KeyType: ddbtypes.KeyTypeRange},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, err := client.DeleteTable(context.Background(), &dynamodb.DeleteTableInput{TableName: aws.String(name)})
			if err != nil {
				t.Errorf("delete test table %s: %v", name, err)
			}
		})
		return name
	}
	st, err := awsstore.Open(ctx, awsstore.Config{
		Bucket: "test", ReposTable: createTable("repos"), VMsTable: createTable("vms"),
		DDB: client, S3: newMemS3(),
	})
	if err != nil {
		t.Fatal(err)
	}

	const lineage, ref, holder = "lin_exec", "refs/heads/main", "agent"
	now := time.Now().UnixMilli()
	_, _, _, err = st.CreateLineageIfAbsent(ctx,
		store.LineageRecord{Lineage: lineage, DefaultRef: ref, CreatedAt: now},
		store.RefRecord{Lineage: lineage, Name: ref, Commit: "c1", Tree: "t1", UpdatedAt: now})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := st.LeaseRef(ctx, store.LeaseRefParams{Lineage: lineage, Ref: ref, Holder: holder, NowMs: now, TTLMs: 60000})
	if err != nil {
		t.Fatal(err)
	}
	vm := &store.VMRecord{
		VMID: "vm_1", Lineage: lineage, Ref: ref, Holder: holder, State: "running",
		HeadCommit: "c1", LeaseEpoch: lease.Epoch, LeaseExpiresAt: lease.ExpiresAt,
	}
	if err := st.CreateRunningVM(ctx, vm); err != nil {
		t.Fatal(err)
	}
	// A result larger than a DynamoDB item is still fully recoverable.
	payload := bytes.Repeat([]byte("result"), 80_000)
	vm.HeadCommit, vm.BilledMs = "c2", 14
	p := store.CompleteExecParams{
		VM: vm, BaseCommit: "c1", Tree: "t2",
		Receipt: store.ExecReceipt{VMID: vm.VMID, ExecID: "exec_1", ResponseJSON: payload, CreatedAt: now},
	}
	if err := st.CompleteExec(ctx, p); err != nil {
		t.Fatalf("complete exec: %v", err)
	}
	assertCommitted := func() {
		t.Helper()
		gotRef, err := st.GetRef(ctx, lineage, ref, now)
		if err != nil || gotRef.Commit != "c2" || gotRef.Tree != "t2" {
			t.Fatalf("expected ref c2/t2, got %+v: %v", gotRef, err)
		}
		gotVM, err := st.GetVM(ctx, vm.VMID)
		if err != nil || gotVM.HeadCommit != "c2" || gotVM.BilledMs != 14 {
			t.Fatalf("expected VM at c2 with 14 billed ms, got %+v: %v", gotVM, err)
		}
		gotReceipt, err := st.GetExecReceipt(ctx, vm.VMID, "exec_1")
		if err != nil || gotReceipt == nil || !bytes.Equal(gotReceipt.ResponseJSON, payload) {
			t.Fatalf("expected original large receipt: %v", err)
		}
	}
	assertCommitted()

	vm.HeadCommit, vm.BilledMs = "c3", 99
	p.BaseCommit, p.Tree, p.Receipt.ResponseJSON = "c2", "t3", []byte("rejected")
	if err := st.CompleteExec(ctx, p); err == nil {
		t.Fatal("duplicate receipt should abort the whole transaction")
	}
	assertCommitted()

	// Renew the ref lease without updating the VM. The old VM cannot publish.
	if _, err := st.LeaseRef(ctx, store.LeaseRefParams{Lineage: lineage, Ref: ref, Holder: holder, NowMs: now, TTLMs: 60000}); err != nil {
		t.Fatal(err)
	}
	p.Receipt.ExecID = "exec_2"
	if err := st.CompleteExec(ctx, p); err == nil {
		t.Fatal("stale lease should abort the whole transaction")
	}
	assertCommitted()
	gotReceipt, err := st.GetExecReceipt(ctx, vm.VMID, "exec_2")
	if err != nil || gotReceipt != nil {
		t.Fatalf("stale lease published a receipt: %+v, %v", gotReceipt, err)
	}

	vm.HeadCommit, p.Tree = p.BaseCommit, "t2"
	p.Receipt.ExecID = "exec_3"
	if err := st.CompleteExec(ctx, p); err == nil {
		t.Fatal("stale lease should also fence commands that did not change the workspace")
	}
	assertCommitted()
}
