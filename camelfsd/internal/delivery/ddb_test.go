package delivery

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
	"github.com/qaml-ai/run/camelfsd/internal/ddb/ddbtest"
)

const testSecret = "ddb-local-delivery-test-key"

func testSender(t *testing.T) Sender {
	t.Helper()
	db, table := ddbtest.Table(t, ddbtest.Schema{
		Keys: []types.KeySchemaElement{
			{AttributeName: aws.String("shard"), KeyType: types.KeyTypeHash},
			{AttributeName: aws.String("id"), KeyType: types.KeyTypeRange},
		},
		Attributes: []types.AttributeDefinition{
			{AttributeName: aws.String("shard"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("id"), AttributeType: types.ScalarAttributeTypeS},
		},
	})
	now := time.Unix(1700000000, 0)
	return Sender{DB: db, Table: table, Node: "a", Signer: HMAC([]byte(testSecret)), Now: func() time.Time { return now }}
}

func stageItem(t *testing.T, s Sender, d Delivery) types.TransactWriteItem {
	t.Helper()
	item, err := Stage(s.Table, d, s.Now())
	if err != nil {
		t.Fatal(err)
	}
	return item
}

func writeItems(t *testing.T, s Sender, items ...types.TransactWriteItem) error {
	t.Helper()
	_, err := s.DB.TransactWriteItems(t.Context(), &dynamodb.TransactWriteItemsInput{TransactItems: items})
	return err
}

func enqueue(t *testing.T, s Sender, d Delivery) {
	t.Helper()
	if err := writeItems(t, s, stageItem(t, s, d)); err != nil {
		t.Fatal(err)
	}
}

func readItem(t *testing.T, s Sender, itemKey map[string]types.AttributeValue) map[string]types.AttributeValue {
	t.Helper()
	out, err := s.DB.GetItem(t.Context(), &dynamodb.GetItemInput{
		TableName: aws.String(s.Table), Key: itemKey, ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	return out.Item
}

func expectPass(t *testing.T, s Sender, want int) {
	t.Helper()
	if sent, err := s.Pass(t.Context()); sent != want || err != nil {
		t.Fatalf("Pass = (%d, %v), want (%d, nil)", sent, err, want)
	}
}

func TestDDBStageTransaction(t *testing.T) {
	s := testSender(t)
	d := Delivery{ID: "transaction", URL: "https://example.com/hook", Body: []byte("{}")}
	item := stageItem(t, s, d)
	stateKey := key("state", "ref")
	update := func(version string) types.TransactWriteItem {
		return types.TransactWriteItem{Update: &types.Update{
			TableName: aws.String(s.Table), Key: stateKey, UpdateExpression: aws.String("SET #version = :version"),
			ExpressionAttributeNames:  map[string]string{"#version": "version"},
			ExpressionAttributeValues: map[string]types.AttributeValue{":version": str(version)},
		}}
	}
	if err := writeItems(t, s, update("v1"), item); err != nil {
		t.Fatal(err)
	}
	deliveryKey := key(Shard(d.ID), d.ID)
	if got := readItem(t, s, deliveryKey); !reflect.DeepEqual(got, item.Put.Item) {
		t.Fatal("transaction did not stage the expected delivery")
	}
	if err := writeItems(t, s, update("v2"), item); !ddb.IsConditionFailed(err) {
		t.Fatalf("duplicate stage error = %v, want condition failure", err)
	}
	if got := readItem(t, s, stateKey)["version"]; !reflect.DeepEqual(got, str("v1")) {
		t.Fatalf("state version = %v, want v1", got)
	}
}

func TestDDBRetriesAndSignature(t *testing.T) {
	s := testSender(t)
	var clock atomic.Int64
	clock.Store(s.Now().UnixMilli())
	s.Now = func() time.Time { return time.UnixMilli(clock.Load()) }
	var calls atomic.Int32
	body := []byte(`{"event":"test"}`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		got, err := io.ReadAll(r.Body)
		if err != nil || string(got) != string(body) {
			t.Error("receiver got an unexpected payload")
		}
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Camel-Delivery") != "retry" {
			t.Error("receiver got an unexpected method or headers")
		}
		ts, sig, ok := strings.Cut(strings.TrimPrefix(r.Header.Get("Camel-Signature"), "t="), ",v1=")
		if !ok || ts != fmt.Sprint(s.Now().Unix()) || !verifies(testSecret, ts, sig, got) || verifies("wrong-key", ts, sig, got) {
			t.Error("receiver could not verify the signature with the expected key only")
		}
		if calls.Add(1) < 3 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	d := Delivery{ID: "retry", URL: server.URL, Body: body}
	enqueue(t, s, d)
	itemKey := key(Shard(d.ID), d.ID)
	for attempt := int64(1); attempt <= 2; attempt++ {
		expectPass(t, s, 1)
		item := readItem(t, s, itemKey)
		if !reflect.DeepEqual(item["attempts"], number(attempt)) ||
			!reflect.DeepEqual(item["claimedUntil"], number(0)) ||
			!reflect.DeepEqual(item["lastError"], str("HTTP 500")) {
			t.Fatalf("wrong retry state on attempt %d", attempt)
		}
		var next int64
		if _, err := fmt.Sscan(item["nextAt"].(*types.AttributeValueMemberN).Value, &next); err != nil {
			t.Fatal(err)
		}
		base := int64(1000) << (attempt - 1)
		delay := next - clock.Load()
		if delay < base*8/10 || delay > base*12/10 {
			t.Fatalf("delay %dms outside attempt %d bounds", delay, attempt)
		}
		clock.Store(next - 1)
		expectPass(t, s, 0)
		clock.Store(next)
	}
	expectPass(t, s, 1)
	expectPass(t, s, 0)
	if calls.Load() != 3 || len(readItem(t, s, itemKey)) != 0 {
		t.Fatal("expected three attempts and deletion after the first 2xx")
	}
}

func verifies(secret, ts, signature string, body []byte) bool {
	got, err := hex.DecodeString(signature)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "."))
	mac.Write(body)
	return err == nil && hmac.Equal(got, mac.Sum(nil))
}

func TestDDBConcurrentSenders(t *testing.T) {
	a := testSender(t)
	a.Lease = time.Hour
	b := a
	b.Node = "b"
	var mu sync.Mutex
	calls := make(map[string]int)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls[r.Header.Get("Camel-Delivery")]++
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	const count = 40
	want := make(map[string]int, count)
	items := make([]types.TransactWriteItem, 0, count)
	for i := 0; len(items) < count; i++ {
		id := fmt.Sprintf("race-%04d", i)
		if Shard(id) == "0" {
			want[id] = 1
			items = append(items, stageItem(t, a, Delivery{ID: id, URL: server.URL, Body: []byte("{}")}))
		}
	}
	if err := writeItems(t, a, items...); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	errs := make(chan error, 2)
	for _, s := range []Sender{a, b} {
		go func() {
			<-start
			for {
				n, err := s.Pass(t.Context())
				if n == 0 || err != nil {
					errs <- err
					return
				}
			}
		}()
	}
	close(start)
	for range 2 {
		if err := <-errs; err != nil {
			t.Error(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if !maps.Equal(calls, want) {
		t.Fatalf("receiver counts = %v, want one POST per staged ID", calls)
	}
	for id := range want {
		if len(readItem(t, a, key("0", id))) != 0 {
			t.Fatalf("delivery %s remains after 2xx", id)
		}
	}
}

func TestDDBExpiredClaim(t *testing.T) {
	a := testSender(t)
	a.defaults()
	b := a
	b.Node = "b"
	now := a.Now()
	b.Now = func() time.Time { return now }
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	d := Delivery{ID: "crash", URL: server.URL, Body: []byte("{}")}
	enqueue(t, a, d)
	itemKey := key(Shard(d.ID), d.ID)
	if claim, err := a.claim(t.Context(), itemKey); err != nil || claim == nil {
		t.Fatalf("first claim did not succeed: %v", err)
	}
	now = now.Add(a.Lease)
	expectPass(t, b, 0)
	now = now.Add(time.Millisecond)
	expectPass(t, b, 1)
	if calls.Load() != 1 || len(readItem(t, b, itemKey)) != 0 {
		t.Fatal("the replacement sender did not complete the delivery once")
	}
}

func TestDDBDrop(t *testing.T) {
	s := testSender(t)
	d := Delivery{ID: "old", URL: "https://user:private@example.com:8443/path?private=query", Body: []byte("private payload")}
	enqueue(t, s, d)
	itemKey := key(Shard(d.ID), d.ID)
	_, err := s.DB.UpdateItem(t.Context(), &dynamodb.UpdateItemInput{
		TableName: aws.String(s.Table), Key: itemKey, UpdateExpression: aws.String("SET lastError = :error"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":error": str("HTTP 500")},
	})
	if err != nil {
		t.Fatal(err)
	}
	later := s.Now().Add(24*time.Hour + time.Millisecond)
	s.Now = func() time.Time { return later }
	logs := 0
	s.Log = func(event string, fields map[string]any) {
		logs++
		want := map[string]any{"id": d.ID, "url": "example.com", "attempts": int64(1), "lastError": "HTTP 500"}
		if event != "delivery_dropped" || !reflect.DeepEqual(fields, want) {
			t.Error("unexpected drop log")
		}
	}
	expectPass(t, s, 0)
	if logs != 1 || len(readItem(t, s, itemKey)) != 0 {
		t.Fatal("expected exactly one drop log and deletion")
	}
}

func TestDDBLostClaimOnSuccess(t *testing.T) {
	a := testSender(t)
	a.defaults()
	b := a
	b.Node = "b"
	later := a.Now().Add(a.Lease + time.Millisecond)
	b.Now = func() time.Time { return later }
	d := Delivery{ID: "late-success", Body: []byte("{}")}
	itemKey := key(Shard(d.ID), d.ID)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Take over before the old sender can finish its successful POST.
		claim, err := b.claim(r.Context(), itemKey)
		if err != nil || claim == nil || claim.attempts != 2 {
			t.Errorf("replacement claim did not succeed on attempt two: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	d.URL = server.URL
	enqueue(t, a, d)
	expectPass(t, a, 1)
	item := readItem(t, b, itemKey)
	if !reflect.DeepEqual(item["claimer"], str(b.Node)) ||
		!reflect.DeepEqual(item["attempts"], number(2)) ||
		!reflect.DeepEqual(item["claimedUntil"], number(later.Add(b.Lease).UnixMilli())) {
		t.Fatal("the old sender changed the replacement sender's claim")
	}
}
