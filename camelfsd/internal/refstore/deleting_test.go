package refstore

import (
	"context"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
	"github.com/qaml-ai/run/camelfsd/internal/ddb/ddbtest"
)

type stampClient struct {
	*dynamodb.Client
	beforeHeal, afterFailedWrite func()
	writes, heals                int
}

func (c *stampClient) UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	if aws.ToString(in.UpdateExpression) == "REMOVE #deleting" {
		c.heals++
		if c.beforeHeal != nil {
			c.beforeHeal()
		}
	}
	if in.ReturnValuesOnConditionCheckFailure == types.ReturnValuesOnConditionCheckFailureAllOld {
		c.writes++
	}
	out, err := c.Client.UpdateItem(ctx, in, opts...)
	if in.ReturnValuesOnConditionCheckFailure == types.ReturnValuesOnConditionCheckFailureAllOld && ddb.IsConditionFailed(err) && c.afterFailedWrite != nil {
		c.afterFailedWrite()
	}
	return out, err
}

func deletionStore(t *testing.T) (*Store, *time.Time, func(string)) {
	t.Helper()
	s, now := localStore(t, nil)
	client, lineages := ddbtest.Table(t, ddbtest.Schema{
		Keys:       []types.KeySchemaElement{{AttributeName: aws.String("lineage"), KeyType: types.KeyTypeHash}},
		Attributes: []types.AttributeDefinition{{AttributeName: aws.String("lineage"), AttributeType: types.ScalarAttributeTypeS}},
	})
	s.GuardLineages(lineages)
	setDeletion := func(deletion string) {
		t.Helper()
		item := attributes{"lineage": str(lineage)}
		if deletion != "" {
			item["deletion"] = str(deletion)
		}
		_, err := client.PutItem(t.Context(), &dynamodb.PutItemInput{TableName: &lineages, Item: item})
		must(t, err)
	}
	setDeletion("")
	return s, now, setDeletion
}

func TestDeletingRefWrites(t *testing.T) {
	target := Target{Version: id(1), Tree: id(2)}
	t.Run("7_stale_stamp_after_partial_unstamp_heals_once", func(t *testing.T) {
		s, _, setDeletion := deletionStore(t)
		ctx := t.Context()
		for _, name := range []string{"first", "last"} {
			must(t, s.Create(ctx, lineage, name, target, nil, nil))
		}
		setDeletion("X")
		must(t, s.StampDeleting(ctx, lineage, "X"))
		// Model a partial unstamp and a rollback that left an old stamp behind.
		must(t, s.removeStamp(ctx, lineage, "first", "X"))
		setDeletion("")
		client := &stampClient{Client: s.client.(*dynamodb.Client)}
		s.client = client
		must(t, s.Watch(ctx, lineage, "last", "agent:watch"))
		if client.writes != 2 || client.heals != 1 {
			t.Fatalf("writes = %d, heals = %d", client.writes, client.heals)
		}
		item, err := s.readItem(ctx, lineage, "last")
		must(t, err)
		if item["deleting"] != nil || item["watchers"] == nil {
			t.Fatalf("healed item = %v", item)
		}
	})

	t.Run("8_heal_cannot_remove_newer_stamp", func(t *testing.T) {
		s, _, setDeletion := deletionStore(t)
		ctx := t.Context()
		must(t, s.Create(ctx, lineage, "main", target, nil, nil))
		setDeletion("X")
		must(t, s.StampDeleting(ctx, lineage, "X"))
		setDeletion("")
		client := &stampClient{Client: s.client.(*dynamodb.Client)}
		client.beforeHeal = func() {
			setDeletion("Y")
			must(t, s.StampDeleting(ctx, lineage, "Y"))
		}
		s.client = client
		wantError(t, s.Watch(ctx, lineage, "main", "agent:watch"), "lineage_blocked", 409)
		item, err := s.readItem(ctx, lineage, "main")
		must(t, err)
		if item["deleting"].(*types.AttributeValueMemberS).Value != "Y" || item["watchers"] != nil ||
			client.writes != 2 || client.heals != 1 {
			t.Fatalf("item = %v, writes = %d, heals = %d", item, client.writes, client.heals)
		}
	})

	t.Run("11_owner_delete_and_sweep_refuse_stamps", func(t *testing.T) {
		s, now, setDeletion := deletionStore(t)
		ctx := t.Context()
		owner, expires := "job:one", now.UnixMilli()+1000
		must(t, s.Create(ctx, lineage, "owned", target, &owner, nil))
		must(t, s.Create(ctx, lineage, "expired", target, nil, &expires))
		*now = time.UnixMilli(expires)
		setDeletion("X")
		must(t, s.StampDeleting(ctx, lineage, "X"))
		deleted, _, err := s.DeleteOwned(ctx, lineage, owner)
		wantError(t, err, "lineage_blocked", 409)
		if len(deleted) != 0 {
			t.Fatal(deleted)
		}
		wantError(t, s.SweepExpired(ctx, lineage), "lineage_blocked", 409)
		for _, name := range []string{"owned", "expired"} {
			item, err := s.readItem(ctx, lineage, name)
			must(t, err)
			if item["version"] == nil {
				t.Fatalf("removed stamped ref %s", name)
			}
		}
	})

	t.Run("12_usage_keeps_its_lineage_guard", func(t *testing.T) {
		s, _, setDeletion := deletionStore(t)
		ctx := t.Context()
		must(t, s.Create(ctx, lineage, "main", target, nil, nil))
		setDeletion("X")
		must(t, s.StampDeleting(ctx, lineage, "X"))
		wantError(t, s.AddWritten(ctx, lineage, 5), "lineage_blocked", 409)
		if err := s.ApplyMark(ctx, lineage, 5, 0, nil); !ddb.IsConditionFailed(err) {
			t.Fatalf("frozen mark = %v", err)
		}
		setDeletion("")
		must(t, s.AddWritten(ctx, lineage, 7))
		must(t, s.ApplyMark(ctx, lineage, 5, 7, nil))
		usage, err := s.ReadUsage(ctx, lineage)
		must(t, err)
		item, err := s.readItem(ctx, lineage, "main")
		must(t, err)
		if usage.MarkedBytes != 5 || usage.WrittenSince != 0 || item["deleting"] == nil {
			t.Fatalf("usage = %+v, ref = %v", usage, item)
		}
	})

	t.Run("rollback_between_renew_failure_and_reread", func(t *testing.T) {
		s, _, setDeletion := deletionStore(t)
		ctx := t.Context()
		must(t, s.Create(ctx, lineage, "main", target, nil, nil))
		lease, err := s.Acquire(ctx, lineage, "main", "vm", 1000)
		must(t, err)
		fence := Fence{Holder: "vm", Epoch: lease.Epoch}
		setDeletion("X")
		must(t, s.StampDeleting(ctx, lineage, "X"))
		client := &stampClient{Client: s.client.(*dynamodb.Client)}
		client.afterFailedWrite = func() {
			must(t, s.UnstampDeleting(ctx, lineage, "X"))
			setDeletion("")
		}
		s.client = client
		_, err = s.Renew(ctx, lineage, "main", fence, 2000)
		wantError(t, err, "lineage_blocked", 409)
		_, err = s.Renew(ctx, lineage, "main", fence, 2000)
		must(t, err)
	})
}
