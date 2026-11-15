package compute

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
)

func TestDDBRefLeaseRecovery(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	_, refs := table(t, "lineage", "name")
	c := f.fresh()
	c.Refs = refstore.New(c.DB, refs, c.Now, nil)
	const pool = "pool"
	f.register(pool, "boot", 1)
	loop := Loop{C: c, Pools: func(context.Context) ([]string, error) { return []string{pool}, nil }}
	target := refstore.Target{Version: strings.Repeat("a", 40), Tree: strings.Repeat("b", 40)}
	place := func(id string) VM {
		req := f.request(id, pool)
		req.Image = strings.Repeat("c", 64)
		req.Ref = id
		if err := c.Refs.Create(ctx, req.Lineage, req.Ref, target, nil, nil); err != nil {
			t.Fatal(err)
		}
		must[VM](t)(c.Create(ctx, req))
		return must[VM](t)(c.Place(ctx, id))
	}
	v := place("recover")
	holder := hostwire.Holder{Host: v.Host, Boot: v.HostEpoch, Mount: v.ID}
	// Leave the durable ref acquisition behind while the VM is still placed.
	lease := must[refstore.Lease](t)(c.Refs.Acquire(ctx, v.Lineage, v.Ref, holder.String(), refLeaseTTL))
	if got := must[VM](t)(c.Get(ctx, v.ID)); got.Phase != Placed || got.RefLeaseHolder != "" {
		t.Fatal(got)
	}
	f.now = f.now.Add(time.Second)
	v = must[VM](t)(c.MarkBooting(ctx, v.ID))
	if v.Phase != Booting || v.RefLeaseEpoch != lease.Epoch || v.RefLeaseHolder != holder.String() || v.RefLeaseDeadline <= lease.Deadline {
		t.Fatal(v)
	}
	reply := must[Reconcile](t)(c.Reconcile(ctx, pool, v.Host, v.HostEpoch, 0, f.now, nil, 30*time.Second))
	if len(reply.Boot) != 1 || reply.Boot[0].ID != v.ID {
		t.Fatal(reply)
	}

	// End committed and removed the VM from its host before Release ran.
	c.afterWrite = func() error { return lostResponse }
	if _, err := c.End(ctx, v.ID, EndRequest{At: f.now, Code: Stopped}); !errors.Is(err, lostResponse) {
		t.Fatal(err)
	}
	c.afterWrite = nil
	if got := must[VM](t)(c.Get(ctx, v.ID)); got.Phase != Ended || got.RefLeaseReleased {
		t.Fatal(got)
	}
	if held := must[refstore.Ref](t)(c.Refs.Get(ctx, v.Lineage, v.Ref)); held.Holder == nil {
		t.Fatal("released before recovery")
	}
	if err := loop.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	if got := must[VM](t)(c.Get(ctx, v.ID)); !got.RefLeaseReleased {
		t.Fatal(got)
	}
	if held := must[refstore.Ref](t)(c.Refs.Get(ctx, v.Lineage, v.Ref)); held.Holder != nil {
		t.Fatal(held)
	}

	var failed []map[string]any
	c.Log = func(event string, fields map[string]any) {
		if event == "vm_start_failed" {
			failed = append(failed, fields)
		}
	}
	v = place("held")
	other := hostwire.Holder{Host: "other", Boot: 1, Mount: "job"}
	must[refstore.Lease](t)(c.Refs.Acquire(ctx, v.Lineage, v.Ref, other.String(), refLeaseTTL))
	v = must[VM](t)(c.MarkBooting(ctx, v.ID))
	if v.Phase != Ended || v.Code != StartFailed || v.Reason != "ref_held" || v.CheckpointError != "ref is leased by another holder" || v.StartedAt != nil || v.UsageSeq != 0 {
		t.Fatal(v)
	}
	f.checkHost(pool, 1)

	v = place("missing")
	if err := c.Refs.Delete(ctx, v.Lineage, v.Ref, nil); err != nil {
		t.Fatal(err)
	}
	v = must[VM](t)(c.MarkBooting(ctx, v.ID))
	if v.Phase != Ended || v.Code != StartFailed || v.Reason != "ref_unavailable" || v.CheckpointError != "mount version or ref unavailable" {
		t.Fatal(v)
	}
	if len(failed) != 2 || failed[0]["reason"] != "ref_held" || failed[0]["refErr"] != "held" ||
		failed[1]["reason"] != "ref_unavailable" || failed[1]["refErr"] != "no_ref" {
		t.Fatal(failed)
	}

	v = place("fenced")
	v = must[VM](t)(c.MarkBooting(ctx, v.ID))
	if err := c.Refs.Release(ctx, v.Lineage, v.Ref, refstore.Fence{Holder: v.RefLeaseHolder, Epoch: v.RefLeaseEpoch}); err != nil {
		t.Fatal(err)
	}
	must[refstore.Lease](t)(c.Refs.Acquire(ctx, v.Lineage, v.Ref, other.String(), refLeaseTTL))
	f.now = f.now.Add(201 * time.Second)
	if err := c.Heartbeat(ctx, pool, v.Host, v.HostEpoch, 0, f.now); err != nil {
		t.Fatal(err)
	}
	if err := loop.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	if got := must[VM](t)(c.Get(ctx, v.ID)); got.Phase != Stopping || got.StopCheckpoint {
		t.Fatal(got)
	}
}

func TestDDBRenewRefDuringDeletionRollback(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	_, refs := table(t, "lineage", "name")
	_, lineages := table(t, "lineage")
	c := f.fresh()
	c.Refs = refstore.New(c.DB, refs, c.Now, nil)
	c.Refs.GuardLineages(lineages)
	req := f.request("renew", "pool")
	req.Image = strings.Repeat("c", 64)
	lineageKey := attrs{"lineage": s(req.Lineage)}
	must[*dynamodb.PutItemOutput](t)(c.DB.PutItem(ctx, &dynamodb.PutItemInput{TableName: &lineages, Item: lineageKey}))
	target := refstore.Target{Version: strings.Repeat("a", 40), Tree: strings.Repeat("b", 40)}
	if err := c.Refs.Create(ctx, req.Lineage, req.Ref, target, nil, nil); err != nil {
		t.Fatal(err)
	}
	f.register(req.Pool, "boot", 1)
	must[VM](t)(c.Create(ctx, req))
	must[VM](t)(c.Place(ctx, req.ID))
	must[*dynamodb.UpdateItemOutput](t)(c.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &lineages, Key: lineageKey, UpdateExpression: aws.String("SET deletion = :id"),
		ExpressionAttributeValues: attrs{":id": s("X")},
	}))
	// The VM acquires its lease after the pre-check but before the stamp.
	v := must[VM](t)(c.MarkBooting(ctx, req.ID))
	v = must[VM](t)(c.Started(ctx, req.ID, v.Host, v.HostEpoch, f.now))
	if err := c.Refs.StampDeleting(ctx, req.Lineage, "X"); err != nil {
		t.Fatal(err)
	}

	f.now = f.now.Add(201 * time.Second)
	var blocked *refstore.Error
	if err := c.renewRef(ctx, v, f.now); !errors.As(err, &blocked) || blocked.Code != "lineage_blocked" {
		t.Fatalf("renew during deletion = %v", err)
	}
	if got := must[VM](t)(c.Get(ctx, v.ID)); got.Phase != Running || got.RefLeaseDeadline != v.RefLeaseDeadline {
		t.Fatalf("VM changed during failed renew: %+v", got)
	}
	if held := must[[]string](t)(c.Refs.Held(ctx, req.Lineage)); len(held) != 1 || held[0] != req.Ref {
		t.Fatalf("post-stamp held refs = %v", held)
	}
	if err := c.Refs.UnstampDeleting(ctx, req.Lineage, "X"); err != nil {
		t.Fatal(err)
	}
	must[*dynamodb.UpdateItemOutput](t)(c.DB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &lineages, Key: lineageKey, UpdateExpression: aws.String("REMOVE deletion"),
	}))
	if err := c.renewRef(ctx, v, f.now); err != nil {
		t.Fatal(err)
	}
	if got := must[VM](t)(c.Get(ctx, v.ID)); got.Phase != Running || got.RefLeaseEpoch != v.RefLeaseEpoch ||
		got.RefLeaseDeadline != f.now.UnixMilli()+refLeaseTTL {
		t.Fatalf("VM after successful renew: %+v", got)
	}
}
