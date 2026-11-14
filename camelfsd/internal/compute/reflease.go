package compute

import (
	"context"
	"errors"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
)

const refLeaseTTL = 600_000
const releasePrefix = "~release#"

func (c *Controller) acquireRef(ctx context.Context, v VM) (refstore.Target, hostwire.Holder, refstore.Lease, error) {
	holder, err := hostwire.ParseHolder((hostwire.Holder{Host: v.Host, Boot: v.HostEpoch, Mount: v.ID}).String())
	if err != nil {
		return refstore.Target{}, holder, refstore.Lease{}, ErrInvalid
	}
	ref, err := c.Refs.Get(ctx, v.Lineage, v.Ref)
	if err != nil {
		return refstore.Target{}, holder, refstore.Lease{}, err
	}
	target := ref.Target
	if v.Version != "" && v.Version != ref.Version {
		if c.CommitTree == nil {
			return refstore.Target{}, holder, refstore.Lease{}, ErrInvalid
		}
		target.Version = v.Version
		target.Tree, err = c.CommitTree(ctx, v.Lineage, v.Version)
		if err != nil {
			return refstore.Target{}, holder, refstore.Lease{}, err
		}
	}
	lease, err := c.Refs.Acquire(ctx, v.Lineage, v.Ref, holder.String(), refLeaseTTL)
	if err == nil && (v.Version == "" || v.Version == ref.Version) {
		// The head may have moved between Get and Acquire. Read it under the fence.
		ref, err = c.Refs.Get(ctx, v.Lineage, v.Ref)
		if err == nil && (ref.Holder == nil || *ref.Holder != holder.String() || ref.LeaseEpoch != lease.Epoch) {
			err = ErrCondition
		}
		if v.Version == "" {
			target = ref.Target
		}
	}
	return target, holder, lease, err
}

func (c *Controller) renewRef(ctx context.Context, v VM, now time.Time) error {
	if c.Refs == nil || v.RefLeaseHolder == "" || v.RefLeaseDeadline-now.UnixMilli() >= 400_000 {
		return nil
	}
	lease, err := c.Refs.Renew(ctx, v.Lineage, v.Ref, refstore.Fence{Holder: v.RefLeaseHolder, Epoch: v.RefLeaseEpoch}, refLeaseTTL)
	var refErr *refstore.Error
	if errors.As(err, &refErr) && refErr.Code == "fenced" {
		c.log("ref_lease_lost", map[string]any{"vm": v.ID})
		if v.Phase == Stopping {
			if !v.StopCheckpoint {
				return nil
			}
			updated, err := c.updateVM(ctx, v.ID, "#phase = :phase AND #refLeaseEpoch = :epoch",
				"SET #stopCheckpoint = :false", attrs{":phase": s(string(Stopping)), ":epoch": n(v.RefLeaseEpoch), ":false": b(false)})
			if err == nil {
				c.pushStop(ctx, updated)
			}
			return err
		}
		_, err = c.stop(ctx, v, now, now.UnixMilli(), Stopped, false)
		return err
	}
	if err != nil {
		return err
	}
	_, err = c.updateVM(ctx, v.ID,
		"#phase <> :ended AND #refLeaseEpoch = :epoch AND #refLeaseDeadline < :deadline",
		"SET #refLeaseDeadline = :deadline",
		attrs{":ended": s(string(Ended)), ":epoch": n(v.RefLeaseEpoch), ":deadline": n(lease.Deadline)})
	return err
}

// The reservation disappears on End. Stage release work with End so the loop
// can recover it by pool without scanning the VM table.
func (c *Controller) releaseWork(v VM) types.TransactWriteItem {
	row := hostKey(v.Pool, releasePrefix+v.ID)
	row["kind"], row["vm"] = s("release"), s(v.ID)
	return put(c.Tables.Hosts, row, "attribute_not_exists(#host)")
}

func (c *Controller) releaseRef(ctx context.Context, v VM) error {
	if c.Refs == nil || v.Phase != Ended || v.RefLeaseHolder == "" || v.RefLeaseReleased {
		return nil
	}
	err := c.Refs.Release(ctx, v.Lineage, v.Ref, refstore.Fence{Holder: v.RefLeaseHolder, Epoch: v.RefLeaseEpoch})
	var refErr *refstore.Error
	// A previous worker may have released it before losing its response.
	if err != nil && (!errors.As(err, &refErr) || refErr.Code != "fenced") {
		return err
	}
	vm := change(c.Tables.VMs, vmKey(v.ID), "#phase = :ended AND #refLeaseEpoch = :epoch",
		"SET #refLeaseReleased = :true", attrs{":ended": s(string(Ended)), ":epoch": n(v.RefLeaseEpoch), ":true": b(true)})
	remove := &types.Delete{TableName: aws.String(c.Tables.Hosts), Key: hostKey(v.Pool, releasePrefix+v.ID)}
	return c.transact(ctx, types.TransactWriteItem{Update: vm}, types.TransactWriteItem{Delete: remove})
}

func (c *Controller) pendingReleases(ctx context.Context, pool string) error {
	if c.Refs == nil {
		return nil
	}
	const cond = "#pool = :pool AND begins_with(#host, :prefix)"
	pages := dynamodb.NewQueryPaginator(c.DB, &dynamodb.QueryInput{
		TableName: aws.String(c.Tables.Hosts), ConsistentRead: aws.Bool(true), KeyConditionExpression: aws.String(cond),
		ExpressionAttributeNames: aliases(cond), ExpressionAttributeValues: attrs{":pool": s(pool), ":prefix": s(releasePrefix)},
	})
	var result error
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return errors.Join(result, err)
		}
		for _, row := range page.Items {
			v, err := c.Get(ctx, item(row).text("vm"))
			if err == nil {
				err = c.releaseRef(ctx, v)
			}
			result = errors.Join(result, err)
		}
	}
	return result
}
