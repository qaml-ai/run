package compute

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

func matches(v VM, req CreateRequest) bool {
	return v.Lineage == req.Lineage && v.Ref == req.Ref && v.Mode == req.Mode && v.Payer == req.Payer
}

func (c *Controller) Create(ctx context.Context, req CreateRequest) (VM, error) {
	now := c.now().UnixMilli()
	if req.ID == "" {
		return VM{}, ErrInvalid
	}
	// Check existing IDs first so a replay still works after the original lease expires.
	v, err := c.Get(ctx, req.ID)
	if err == nil {
		return replayCreate(v, req)
	}
	if !errors.Is(err, ErrNotFound) {
		return VM{}, err
	}
	if req.Pool == "" || req.Shape.MemoryMiB < 0 || req.Deadline.IsZero() || req.Deadline.UnixMilli() <= now {
		return VM{}, ErrInvalid
	}
	if c.Refs != nil && (!hostwire.MountID.MatchString(req.ID) || req.ID == "." || req.ID == ".." || !root.Hex(req.Image, 64)) {
		return VM{}, ErrInvalid
	}
	v = VM{CreateRequest: req, CreatedAt: now, Phase: Requested, LeaseDeadline: req.Deadline.UnixMilli()}
	i := vmItem(v)
	waiter := hostKey(v.Pool, waiterKey(v))
	waiter["kind"], waiter["vm"], waiter["createdAt"] = s("wait"), s(v.ID), n(now)
	waiter["memoryMiB"], waiter["vcpus"] = n(int64(v.Shape.MemoryMiB)), n(int64(v.Shape.VCPUs))
	err = c.transact(ctx, put(c.Tables.VMs, i, "attribute_not_exists(#id)"),
		put(c.Tables.Hosts, waiter, "attribute_not_exists(#host)"))
	if errors.Is(err, ErrCondition) {
		if current, readErr := c.Get(ctx, v.ID); readErr == nil {
			return replayCreate(current, req)
		}
	}
	if err != nil {
		return VM{}, err
	}
	return readVM(i), nil
}

func replayCreate(v VM, req CreateRequest) (VM, error) {
	if !matches(v, req) {
		return VM{}, ErrConflict
	}
	return v, nil
}

func waiterKey(v VM) string {
	return fmt.Sprintf("~wait#%015d#%s", v.CreatedAt, v.ID)
}

func (c *Controller) deleteWaiter(v VM) types.TransactWriteItem {
	return types.TransactWriteItem{Delete: &types.Delete{
		TableName: aws.String(c.Tables.Hosts), Key: hostKey(v.Pool, waiterKey(v)),
		ConditionExpression: aws.String("attribute_exists(#host)"), ExpressionAttributeNames: aliases("#host"),
	}}
}

func (c *Controller) Place(ctx context.Context, id string) (VM, error) {
	v, err := c.Get(ctx, id)
	if err != nil || v.Phase != Requested {
		return v, err
	}
	return c.place(ctx, v, c.now().UnixMilli())
}

func (c *Controller) place(ctx context.Context, v VM, now int64) (VM, error) {
	id := v.ID
	hosts, err := c.Hosts(ctx, v.Pool)
	if err != nil {
		return VM{}, err
	}
	for _, h := range rankImage(hosts, v.Shape, c.hostCutoff(now), v.Image) {
		vm := change(c.Tables.VMs, vmKey(id), "#phase = :requested AND #leaseDeadline > :now",
			"SET #phase = :placed, #host = :host, #hostEpoch = :epoch, #placedAt = :now",
			attrs{":requested": s(string(Requested)), ":placed": s(string(Placed)), ":host": s(h.Host),
				":epoch": n(h.BootEpoch), ":now": n(now)})
		host := change(c.Tables.Hosts, hostKey(h.Pool, h.Host),
			"#free > :zero AND #freeMiB >= :mem AND #bootEpoch = :epoch AND #draining = :false AND #lastSeenAt > :cutoff",
			"SET #free = #free - :one, #freeMiB = #freeMiB - :mem ADD #vms :vm",
			attrs{":zero": n(0), ":epoch": n(h.BootEpoch), ":false": b(false), ":cutoff": n(c.hostCutoff(now)),
				":one": n(1), ":mem": n(int64(v.Shape.MemoryMiB)), ":vm": ss(id)})
		err = c.transact(ctx, types.TransactWriteItem{Update: vm}, types.TransactWriteItem{Update: host}, c.deleteWaiter(v))
		if err == nil {
			return c.Get(ctx, id)
		}
		var canceled *types.TransactionCanceledException
		if errors.Is(err, ErrCondition) && errors.As(err, &canceled) &&
			len(canceled.CancellationReasons) == 3 &&
			aws.ToString(canceled.CancellationReasons[0].Code) == "None" &&
			aws.ToString(canceled.CancellationReasons[1].Code) == "ConditionalCheckFailed" &&
			aws.ToString(canceled.CancellationReasons[2].Code) == "None" {
			continue
		}
		return VM{}, err
	}
	return v, ErrNoHost
}

func (c *Controller) MarkBooting(ctx context.Context, id string) (VM, error) {
	v, err := c.Get(ctx, id)
	if err != nil {
		return v, err
	}
	switch v.Phase {
	case Booting, Running, Stopping, Ended:
		return v, nil
	case Placed:
	default:
		return v, ErrPhase
	}
	return c.markBooting(ctx, v)
}

func (c *Controller) markBooting(ctx context.Context, v VM) (VM, error) {
	expr := "SET #phase = :booting, #bootingAt = :now"
	values := attrs{":placed": s(string(Placed)), ":booting": s(string(Booting)), ":host": s(v.Host), ":epoch": n(v.HostEpoch)}
	if c.Refs != nil {
		target, holder, lease, err := c.acquireRef(ctx, v)
		if err != nil {
			var refErr *refstore.Error
			switch {
			case errors.As(err, &refErr) && refErr.Code == "held":
				return c.end(ctx, v, EndRequest{At: c.now(), Code: StartFailed, CheckpointError: "ref is leased by another holder"}, c.now(), nil)
			case errors.As(err, &refErr) && refErr.Code == "no_ref", errors.Is(err, os.ErrNotExist), errors.Is(err, ErrInvalid):
				return c.end(ctx, v, EndRequest{At: c.now(), Code: StartFailed, CheckpointError: "mount version or ref unavailable"}, c.now(), nil)
			default:
				return VM{}, err
			}
		}
		expr += ", #version = :version, #tree = :tree, #refLeaseHolder = :holder, #refLeaseEpoch = :refEpoch, #refLeaseDeadline = :refDeadline"
		values[":version"], values[":tree"], values[":holder"] = s(target.Version), s(target.Tree), s(holder.String())
		values[":refEpoch"], values[":refDeadline"] = n(lease.Epoch), n(lease.Deadline)
	}
	values[":now"] = n(c.now().UnixMilli())
	if c.Refs == nil {
		return c.updateVM(ctx, v.ID, "#phase = :placed AND "+vmHost+" AND #leaseDeadline > :now", expr, values)
	}
	// A reboot must fence a boot even while it is draining the prior VM rows.
	vm := change(c.Tables.VMs, vmKey(v.ID), "#phase = :placed AND "+vmHost+" AND #leaseDeadline > :now", expr, values)
	if err := c.transact(ctx, types.TransactWriteItem{Update: vm}, c.currentHostCheck(v)); err != nil {
		return VM{}, err
	}
	return c.Get(ctx, v.ID)
}

const vmHost = "#host = :host AND #hostEpoch = :epoch"

func (c *Controller) Started(ctx context.Context, id, host string, hostEpoch int64, at time.Time) (VM, error) {
	v, err := c.Get(ctx, id)
	if err != nil {
		return v, err
	}
	if v.Host != host || v.HostEpoch != hostEpoch {
		return v, ErrHost
	}
	return c.started(ctx, v, at, false)
}

func (c *Controller) StartedFromHost(ctx context.Context, id string, h Host, at time.Time) (VM, error) {
	v, err := c.Get(ctx, id)
	if err != nil {
		return v, err
	}
	if !v.onHost(h) || h.Restarting || h.Lost {
		return v, ErrHost
	}
	v, err = c.started(ctx, v, at, true)
	if errors.Is(err, ErrCondition) {
		current, hostErr := c.Host(ctx, h.Pool, h.Host)
		if hostErr != nil {
			return VM{}, hostErr
		}
		if current.BootEpoch != h.BootEpoch || current.Lost || current.Restarting {
			return VM{}, ErrHost
		}
	}
	return v, err
}

func (c *Controller) started(ctx context.Context, v VM, at time.Time, checkHost bool) (VM, error) {
	if v.StartedAt != nil || v.Phase == Ended {
		return v, nil
	}
	// A host can report a start after a stop overtook the boot. Record it
	// without clearing the stop or opening another running transition.
	if v.Phase != Booting && (v.Phase != Stopping || v.BootingAt == nil) {
		return v, ErrPhase
	}

	// MONEY: The first host start report anchors all usage. A replay never resets the ledger.
	started := max(*v.BootingAt, min(at.UnixMilli(), c.now().UnixMilli()))
	phase := Running
	if v.Phase == Stopping {
		phase = Stopping
	}
	expr := "SET #phase = :next, #startedAt = :started, #billedTo = :started, #usageSeq = :zero"
	values := attrs{":phase": s(string(v.Phase)), ":next": s(string(phase)), ":host": s(v.Host),
		":epoch": n(v.HostEpoch), ":started": n(started), ":zero": n(0)}
	if v.Mode == JobMode && v.Job != nil {
		expr += ", #deadlineAt = :deadline"
		values[":deadline"] = n(started + v.Job.TimeoutS*1000 + JobDeadlineGrace.Milliseconds())
	}
	const condition = "#phase = :phase AND " + vmHost + " AND attribute_not_exists(#startedAt)"
	if !checkHost {
		return c.updateVM(ctx, v.ID, condition, expr, values)
	}
	vm := change(c.Tables.VMs, vmKey(v.ID), condition, expr, values)
	if err := c.transact(ctx, types.TransactWriteItem{Update: vm}, c.currentHostCheck(v)); err != nil {
		return VM{}, err
	}
	return c.Get(ctx, v.ID)
}

func (c *Controller) Listed(ctx context.Context, id, host string, hostEpoch int64, at time.Time) (VM, error) {
	v, err := c.Get(ctx, id)
	if err != nil {
		return v, err
	}
	if v.Host != host || v.HostEpoch != hostEpoch {
		return v, ErrHost
	}
	if v.Phase == Ended {
		return v, nil
	}
	if v.Phase == Requested {
		return v, ErrPhase
	}
	if v.LastListedAt == nil || *v.LastListedAt < at.UnixMilli() {
		_, err = c.updateVM(ctx, id, "#phase = :phase AND "+vmHost+
			" AND (attribute_not_exists(#lastListedAt) OR #lastListedAt < :at)", "SET #lastListedAt = :at",
			attrs{":phase": s(string(v.Phase)), ":host": s(host), ":epoch": n(hostEpoch), ":at": n(at.UnixMilli())})
		if err != nil {
			return VM{}, err
		}
	}
	return c.ExtendUsage(ctx, id, at)
}

func (c *Controller) RequestStop(ctx context.Context, id string, checkpoint bool) (VM, error) {
	v, err := c.Get(ctx, id)
	if err != nil {
		return v, err
	}
	now := c.now()
	return c.stop(ctx, v, now, now.UnixMilli(), Stopped, checkpoint)
}

func (c *Controller) ExtendDeadline(ctx context.Context, id string, until time.Time) (VM, error) {
	v, err := c.Get(ctx, id)
	if err != nil || v.Phase == Ended || v.LeaseDeadline >= until.UnixMilli() {
		return v, err
	}
	// MONEY: a lapsed lease is final. Reviving it would bill the lapsed gap retroactively (usage is clamped to the
	// deadline only while it stands), and ExpireLease may already have stopped the VM at the old deadline.
	now := c.now().UnixMilli()
	if now >= v.LeaseDeadline {
		return v, ErrLeaseExpired
	}
	updated, err := c.updateVM(ctx, id, "attribute_exists(#phase) AND #phase <> :ended AND #leaseDeadline < :until AND #leaseDeadline > :now",
		"SET #leaseDeadline = :until", attrs{":ended": s(string(Ended)), ":until": n(until.UnixMilli()), ":now": n(now)})
	if errors.Is(err, ErrCondition) {
		if current, readErr := c.Get(ctx, id); readErr == nil && (current.Phase == Ended || current.LeaseDeadline >= until.UnixMilli()) {
			return current, nil
		} else if readErr == nil && now >= current.LeaseDeadline {
			return current, ErrLeaseExpired
		}
	}
	return updated, err
}

func (c *Controller) ExpireLease(ctx context.Context, id string) (VM, error) {
	v, err := c.Get(ctx, id)
	now := c.now()
	if err != nil || now.UnixMilli() < v.LeaseDeadline {
		return v, err
	}
	return c.stop(ctx, v, now, v.LeaseDeadline, LeaseExpired, true)
}

func (c *Controller) ExpireWaiting(ctx context.Context, id string, waitMs int64) (VM, error) {
	v, err := c.Get(ctx, id)
	now := c.now()
	if err != nil || v.Phase != Requested || now.UnixMilli()-v.CreatedAt <= waitMs {
		return v, err
	}
	return c.end(ctx, v, EndRequest{At: now, Code: StartFailed}, now, nil)
}

type stopIntent struct {
	at         int64
	reason     EndCode
	checkpoint bool
}

func (c *Controller) stop(ctx context.Context, v VM, now time.Time, at int64, reason EndCode, checkpoint bool) (VM, error) {
	switch v.Phase {
	case Ended, Stopping:
		return v, nil
	case Requested, Placed:
		return c.end(ctx, v, EndRequest{At: time.UnixMilli(at), Code: reason}, now, &stopIntent{at, reason, checkpoint})
	case Booting, Running:
		updated, err := c.updateVM(ctx, v.ID, "#phase = :phase AND #leaseDeadline = :lease AND attribute_not_exists(#stopRequestedAt)",
			"SET #phase = :stopping, #stopRequestedAt = :at, #stopCheckpoint = :checkpoint, #stopReason = :reason",
			attrs{":phase": s(string(v.Phase)), ":stopping": s(string(Stopping)), ":at": n(at),
				":checkpoint": b(checkpoint), ":reason": s(string(reason)), ":lease": n(v.LeaseDeadline)})
		if err == nil {
			c.pushStop(ctx, updated)
		}
		return updated, err
	default:
		return v, ErrPhase
	}
}
