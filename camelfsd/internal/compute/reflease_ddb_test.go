package compute

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

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
	if _, err := c.End(ctx, v.ID, EndRequest{At: f.now, Code: Exit}); !errors.Is(err, lostResponse) {
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

	v = place("held")
	other := hostwire.Holder{Host: "other", Boot: 1, Mount: "job"}
	must[refstore.Lease](t)(c.Refs.Acquire(ctx, v.Lineage, v.Ref, other.String(), refLeaseTTL))
	v = must[VM](t)(c.MarkBooting(ctx, v.ID))
	if v.Code != StartFailed || v.CheckpointError != "ref is leased by another holder" || v.StartedAt != nil || v.UsageSeq != 0 {
		t.Fatal(v)
	}
	f.checkHost(pool, 1)

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
