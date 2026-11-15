package api

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb/ddbtest"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
)

const deleteLineage = "test:delete"

var deleteTarget = refstore.Target{Version: strings.Repeat("a", 40), Tree: strings.Repeat("b", 40)}

type deletionClient struct {
	*dynamodb.Client
	beforeStamp, afterStamp func(string) error
	beforeClear             func()
	afterUnstamp            func() error
	stamps                  int
}

func (c *deletionClient) TransactWriteItems(ctx context.Context, in *dynamodb.TransactWriteItemsInput, opts ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	update := in.TransactItems[1].Update
	if aws.ToString(update.UpdateExpression) != "SET #deleting = :id" {
		return c.Client.TransactWriteItems(ctx, in, opts...)
	}
	name := update.Key["name"].(*types.AttributeValueMemberS).Value
	if c.beforeStamp != nil {
		if err := c.beforeStamp(name); err != nil {
			return nil, err
		}
	}
	out, err := c.Client.TransactWriteItems(ctx, in, opts...)
	if err == nil {
		c.stamps++
		if c.afterStamp != nil {
			err = c.afterStamp(name)
		}
	}
	return out, err
}

func (c *deletionClient) UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	if c.beforeClear != nil && strings.HasPrefix(aws.ToString(in.UpdateExpression), "REMOVE #version,") {
		c.beforeClear()
	}
	out, err := c.Client.UpdateItem(ctx, in, opts...)
	if err == nil && c.afterUnstamp != nil && aws.ToString(in.UpdateExpression) == "REMOVE #deleting" {
		err = c.afterUnstamp()
	}
	return out, err
}

type deletionFixture struct {
	t *testing.T
	*deletionClient
	lineages *lineageStore
	refs     *refstore.Store
	refTable string
}

func newDeletionFixture(t *testing.T, names ...string) deletionFixture {
	t.Helper()
	client, lineages := ddbtest.Table(t, refTableSchema("lineage"))
	_, refTable := ddbtest.Table(t, refTableSchema("lineage", "name"))
	now := func() time.Time { return time.UnixMilli(1_800_000_000_000) }
	db := &deletionClient{Client: client}
	f := deletionFixture{t, db, &lineageStore{client: client, table: &lineages, now: now}, refstore.New(db, refTable, now, nil), refTable}
	f.refs.GuardLineages(lineages)
	_, _, err := f.lineages.create(t.Context(), deleteLineage, lineageItem{Tenant: "test", Kind: "workspace", DefaultBranch: "main"})
	f.must(err)
	for _, name := range names {
		f.must(f.create(name))
	}
	return f
}

func (f deletionFixture) must(err error) {
	f.t.Helper()
	if err != nil {
		f.t.Fatal(err)
	}
}

func (f deletionFixture) create(name string) error {
	return f.refs.Create(f.t.Context(), deleteLineage, name, deleteTarget, nil, nil)
}

func (f deletionFixture) move(name string) error {
	_, err := f.refs.Cas(f.t.Context(), deleteLineage, name, refstore.Move{
		Kind: "commit", Version: strings.Repeat("c", 40), Tree: deleteTarget.Tree, Parents: []string{deleteTarget.Version},
	})
	return err
}

func (f deletionFixture) delete() error {
	return f.lineages.delete(f.t.Context(), deleteLineage, f.refs)
}

func (f deletionFixture) item() lineageItem {
	f.t.Helper()
	item, err := f.lineages.get(f.t.Context(), deleteLineage)
	f.must(err)
	return item
}

func (f deletionFixture) refItem(name string) map[string]types.AttributeValue {
	f.t.Helper()
	key := lineageKey(deleteLineage)
	key["name"] = &types.AttributeValueMemberS{Value: name}
	out, err := f.GetItem(f.t.Context(), &dynamodb.GetItemInput{TableName: &f.refTable, Key: key, ConsistentRead: aws.Bool(true)})
	f.must(err)
	return out.Item
}

func (f deletionFixture) refError(err error, code string, status int) {
	f.t.Helper()
	var got *refstore.Error
	if !errors.As(err, &got) || got.Code != code || got.Status != status {
		f.t.Fatalf("ref error = %v, want %d %s", err, status, code)
	}
}

func (f deletionFixture) held(err error, name string) {
	f.t.Helper()
	var got *storageError
	if !errors.As(err, &got) || got.status != 409 || got.code != "held" || !reflect.DeepEqual(got.details, map[string]any{"held": []string{name}}) {
		f.t.Fatalf("delete error = %#v, want 409 held for %s", err, name)
	}
	if item := f.item(); item.Deletion != "" || item.DeletedAt != nil {
		f.t.Fatalf("lineage did not roll back: %+v", item)
	}
}

func TestLineageDeletionStampProtocol(t *testing.T) {
	t.Run("1_write_after_freeze_before_stamp", func(t *testing.T) {
		f := newDeletionFixture(t, "main")
		f.beforeStamp = func(name string) error {
			if f.item().Deletion == "" {
				t.Fatal("deletion was not frozen")
			}
			return f.move(name)
		}
		f.must(f.delete())
		f.refError(f.move("main"), "lineage_blocked", 409)
	})

	t.Run("2_write_and_stamp_both_orders", func(t *testing.T) {
		f := newDeletionFixture(t, "main")
		f.beforeStamp = func(name string) error { return f.move(name) }
		f.afterStamp = func(name string) error {
			if v := f.refItem(name)["version"].(*types.AttributeValueMemberS).Value; v != strings.Repeat("c", 40) {
				t.Fatalf("pre-stamp write missing: %s", v)
			}
			err := f.refs.Watch(t.Context(), deleteLineage, name, "agent:watch")
			f.refError(err, "lineage_blocked", 409)
			return nil
		}
		f.must(f.delete())
	})

	t.Run("3_held_check_observes_acquire", func(t *testing.T) {
		f := newDeletionFixture(t, "main")
		f.beforeStamp = func(name string) error {
			_, err := f.refs.Acquire(t.Context(), deleteLineage, name, "vm", 1000)
			return err
		}
		f.held(f.delete(), "main")
		if item := f.refItem("main"); item["deleting"] != nil || item["holder"] == nil {
			t.Fatalf("rollback ref = %v", item)
		}
	})

	t.Run("4_creation_ordered_against_freeze", func(t *testing.T) {
		f := newDeletionFixture(t, "before")
		f.beforeStamp = func(string) error {
			f.refError(f.create("after"), "lineage_blocked", 409)
			return nil
		}
		f.must(f.delete())
		if item := f.refItem("before"); item["deleting"] == nil || item["version"] != nil {
			t.Fatalf("pre-freeze create was not stamped and cleared: %v", item)
		}
	})

	t.Run("5_no_creation_mid_sweep", func(t *testing.T) {
		f := newDeletionFixture(t, "first", "last")
		f.afterStamp = func(name string) error {
			if name == "first" {
				f.refError(f.create("earlier"), "lineage_blocked", 409)
				_, err := f.refs.Cas(t.Context(), deleteLineage, "later", refstore.Move{
					Kind: "commit", Version: deleteTarget.Version, Tree: deleteTarget.Tree, ExpectAbsent: true,
				})
				f.refError(err, "lineage_blocked", 409)
			}
			return nil
		}
		f.must(f.delete())
		if f.stamps != 2 || len(f.refItem("earlier")) != 0 || len(f.refItem("later")) != 0 {
			t.Fatal("a creation landed during the sweep")
		}
	})

	t.Run("6_retry_after_partial_stamp", func(t *testing.T) {
		f := newDeletionFixture(t, "first", "last")
		crash := errors.New("crash after first stamp")
		f.afterStamp = func(string) error { return crash }
		if err := f.delete(); !errors.Is(err, crash) {
			t.Fatal(err)
		}
		id := f.item().Deletion
		f.refError(f.move("first"), "lineage_blocked", 409)
		f.must(f.move("last"))
		f.afterStamp = nil
		f.must(f.delete())
		for _, name := range []string{"first", "last"} {
			item := f.refItem(name)
			if item["version"] != nil || !reflect.DeepEqual(item["deleting"], &types.AttributeValueMemberS{Value: id}) {
				t.Fatalf("ref %s after retry = %v", name, item)
			}
		}
	})

	t.Run("7_retry_resumes_partial_unstamp", func(t *testing.T) {
		f := newDeletionFixture(t, "first", "last")
		f.beforeStamp = func(name string) error {
			if name == "last" {
				_, err := f.refs.Acquire(t.Context(), deleteLineage, name, "vm", 1000)
				return err
			}
			return nil
		}
		crash := errors.New("crash during unstamp")
		f.afterUnstamp = func() error { return crash }
		if err := f.delete(); !errors.Is(err, crash) {
			t.Fatal(err)
		}
		if item := f.item(); item.Deletion == "" || item.DeletionPhase != lineageRollback ||
			f.refItem("first")["deleting"] != nil || f.refItem("last")["deleting"] == nil {
			t.Fatalf("partial rollback = %+v", item)
		}
		f.afterUnstamp = nil
		f.held(f.delete(), "last")
		if item := f.refItem("last"); item["deleting"] != nil || item["holder"] == nil || f.stamps != 2 {
			t.Fatalf("rollback retry = %v, stamp count = %d", item, f.stamps)
		}
	})

	t.Run("9_concurrent_deleters", func(t *testing.T) {
		f := newDeletionFixture(t, "main")
		otherRefs := refstore.New(f.Client, f.refTable, f.lineages.now, nil)
		otherRefs.GuardLineages(aws.ToString(f.lineages.table))
		f.beforeStamp = func(string) error {
			id := f.item().Deletion
			f.must(f.lineages.delete(t.Context(), deleteLineage, otherRefs))
			if !reflect.DeepEqual(f.refItem("main")["deleting"], &types.AttributeValueMemberS{Value: id}) {
				t.Fatal("second DELETE did not reuse the first id")
			}
			return nil
		}
		err := f.delete()
		var got *storageError
		if !errors.As(err, &got) || got.status != 410 || f.item().DeletedAt == nil {
			t.Fatalf("first DELETE returned %v", err)
		}
	})

	t.Run("10_no_write_after_held_check", func(t *testing.T) {
		f := newDeletionFixture(t, "main")
		f.beforeClear = func() {
			if f.item().DeletionPhase != lineageClear {
				t.Fatal("clear ran before the held decision")
			}
			f.refError(f.move("main"), "lineage_blocked", 409)
			f.refError(f.create("new"), "lineage_blocked", 409)
		}
		f.must(f.delete())
	})

	t.Run("13_reads_ignore_stamp", func(t *testing.T) {
		f := newDeletionFixture(t, "main")
		ctx := t.Context()
		f.beforeStamp = func(name string) error {
			_, err := f.refs.Acquire(ctx, deleteLineage, name, "vm", 1000)
			return err
		}
		f.afterStamp = func(name string) error {
			head, err := f.refs.Get(ctx, deleteLineage, name)
			f.must(err)
			list, _, err := f.refs.List(ctx, deleteLineage, "", "", 10)
			f.must(err)
			held, err := f.refs.Held(ctx, deleteLineage)
			f.must(err)
			if head.Target != deleteTarget || !reflect.DeepEqual(list, []refstore.Ref{head}) || !reflect.DeepEqual(held, []string{name}) {
				t.Fatalf("stamped Get = %+v, List = %+v, Held = %v", head, list, held)
			}
			return nil
		}
		f.held(f.delete(), "main")
	})

	t.Run("14_acquires_and_renew_during_refused_delete", func(t *testing.T) {
		f := newDeletionFixture(t, "first", "last")
		ctx := t.Context()
		var fence refstore.Fence
		f.beforeStamp = func(name string) error {
			if name == "first" {
				lease, err := f.refs.Acquire(ctx, deleteLineage, name, "vm", 1000)
				f.must(err)
				fence = refstore.Fence{Holder: "vm", Epoch: lease.Epoch}
			}
			return nil
		}
		f.afterStamp = func(name string) error {
			if name == "last" {
				_, err := f.refs.Acquire(ctx, deleteLineage, name, "late-vm", 1000)
				f.refError(err, "lineage_blocked", 409)
				_, err = f.refs.Renew(ctx, deleteLineage, "first", fence, 2000)
				f.refError(err, "lineage_blocked", 409)
			}
			return nil
		}
		f.held(f.delete(), "first")
		renewed, err := f.refs.Renew(ctx, deleteLineage, "first", fence, 2000)
		f.must(err)
		if renewed.Epoch != fence.Epoch || renewed.Deadline != f.lineages.now().UnixMilli()+2000 {
			t.Fatalf("renew after rollback = %+v", renewed)
		}
		if last, err := f.refs.Get(ctx, deleteLineage, "last"); err != nil || last.Holder != nil {
			t.Fatalf("lease landed after stamp: %+v, %v", last, err)
		}
	})

	t.Run("removed_ref_is_not_recreated_by_stamp", func(t *testing.T) {
		f := newDeletionFixture(t, "main")
		f.beforeStamp = func(name string) error {
			key := lineageKey(deleteLineage)
			key["name"] = &types.AttributeValueMemberS{Value: name}
			_, err := f.DeleteItem(t.Context(), &dynamodb.DeleteItemInput{TableName: &f.refTable, Key: key})
			return err
		}
		f.must(f.delete())
		if item := f.refItem("main"); len(item) != 0 {
			t.Fatalf("stamp created a phantom item: %v", item)
		}
	})

	t.Run("legacy_clearing_resumes_with_stamps", func(t *testing.T) {
		f := newDeletionFixture(t, "main")
		f.must(f.lineages.change(t.Context(), deleteLineage, "attribute_exists(#lineage)",
			"SET #deletion = :id, #clearing = :yes",
			map[string]string{"#lineage": "lineage", "#deletion": "deletion", "#clearing": "clearing"},
			map[string]types.AttributeValue{":id": &types.AttributeValueMemberS{Value: "legacy"}, ":yes": &types.AttributeValueMemberBOOL{Value: true}}))
		f.must(f.delete())
		item := f.refItem("main")
		if item["version"] != nil || !reflect.DeepEqual(item["deleting"], &types.AttributeValueMemberS{Value: "legacy"}) {
			t.Fatalf("legacy clear = %v", item)
		}
	})

	t.Run("held_precheck_writes_zero_stamps", func(t *testing.T) {
		f := newDeletionFixture(t, "main", "other")
		_, err := f.refs.Acquire(t.Context(), deleteLineage, "main", "vm", 1000)
		f.must(err)
		f.beforeStamp = func(string) error {
			t.Fatal("held pre-check reached the stamp sweep")
			return nil
		}
		f.held(f.delete(), "main")
	})
}

// A stamp whose lineage check fails for a reason the protocol does not know
// (not a competing DELETE advancing the phase) must not spin the DELETE: it
// re-reads the same state deletionStallLimit times and then answers 503, which
// the runtime retries durably.
func TestLineageDeletionStallIsBounded(t *testing.T) {
	f := newDeletionFixture(t, "main")
	attempts := 0
	f.beforeStamp = func(string) error {
		attempts++
		return &types.TransactionCanceledException{
			Message: aws.String("Transaction cancelled"),
			CancellationReasons: []types.CancellationReason{
				{Code: aws.String("ConditionalCheckFailed")}, {Code: aws.String("None")},
			},
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	err := f.lineages.delete(ctx, deleteLineage, f.refs)
	var got *storageError
	if !errors.As(err, &got) || got.status != 503 || got.code != "unavailable" {
		t.Fatalf("delete error = %#v, want 503 unavailable", err)
	}
	details, _ := got.details.(map[string]any)
	if details["stalled"] != deletionStallLimit || details["phase"] != "" || details["deletion"] == "" {
		t.Fatalf("details = %v", details)
	}
	if attempts != deletionStallLimit {
		t.Fatalf("stamp attempts = %d, want %d", attempts, deletionStallLimit)
	}
	if item := f.item(); item.Deletion == "" || item.DeletionPhase != "" {
		t.Fatalf("lineage after the stall = %+v, want the frozen deletion kept for the retry", item)
	}
	f.beforeStamp = nil
	f.must(f.delete())
	if f.item().DeletedAt == nil {
		t.Fatal("the retried DELETE did not tombstone the lineage")
	}
}
