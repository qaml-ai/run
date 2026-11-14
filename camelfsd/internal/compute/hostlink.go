package compute

import (
	"context"
	"errors"
	"log/slog"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

func (c *Controller) currentHostCheck(v VM) types.TransactWriteItem {
	const condition = "#bootEpoch = :epoch AND attribute_not_exists(#restarting) AND attribute_not_exists(#lost)"
	return types.TransactWriteItem{ConditionCheck: &types.ConditionCheck{
		TableName: aws.String(c.Tables.Hosts), Key: hostKey(v.Pool, v.Host),
		ConditionExpression: aws.String(condition), ExpressionAttributeNames: aliases(condition),
		ExpressionAttributeValues: attrs{":epoch": n(v.HostEpoch)},
	}}
}

func (c *Controller) log(event string, fields map[string]any) {
	if c.Log != nil {
		c.Log(event, fields)
		return
	}
	var args []any
	for key, value := range fields {
		args = append(args, key, value)
	}
	slog.Warn(event, args...)
}

func (v VM) BootSpec() (hostwire.BootSpec, error) {
	if !root.Hex(v.Image, 64) {
		return hostwire.BootSpec{}, ErrInvalid
	}
	holder, err := hostwire.ParseHolder(v.RefLeaseHolder)
	if err != nil {
		return hostwire.BootSpec{}, err
	}
	q := hostwire.BootSpec{
		ID: v.ID, Lineage: v.Lineage, Ref: v.Ref, Version: v.Version, Tree: v.Tree, Parent: v.Version, Image: v.Image,
		Lease:    hostwire.Lease{Holder: holder, Epoch: v.RefLeaseEpoch, Deadline: v.RefLeaseDeadline},
		Shape:    hostwire.Shape{VCPUs: v.Shape.VCPUs, MemoryMiB: v.Shape.MemoryMiB, DiskMiB: v.Shape.diskMiB()},
		Internet: v.Internet, Deadline: v.LeaseDeadline,
	}
	if v.Session != nil {
		q.Session = &hostwire.Session{IdleStopS: v.Session.IdleStopS}
	}
	return q, nil
}

func (c *Controller) pushBoot(ctx context.Context, v VM) {
	if c.Pusher == nil || v.Phase != Booting {
		return
	}
	h, err := c.Host(ctx, v.Pool, v.Host)
	if err == nil && v.onHost(h) && !h.Lost && !h.Restarting {
		var spec hostwire.BootSpec
		spec, err = v.BootSpec()
		if err == nil {
			err = c.Pusher.Boot(ctx, h, spec)
		}
	}
	if err != nil {
		c.log("host_boot_push_failed", map[string]any{"vm": v.ID, "host": v.Host, "error": err.Error()})
	}
}

func (c *Controller) pushStop(ctx context.Context, v VM) {
	if c.Pusher == nil || v.Phase != Stopping {
		return
	}
	h, err := c.Host(ctx, v.Pool, v.Host)
	if err == nil && v.onHost(h) && !h.Lost && !h.Restarting {
		err = c.Pusher.Stop(ctx, h, v.ID, v.StopCheckpoint)
	}
	if err != nil && !errors.Is(err, context.Canceled) {
		c.log("host_stop_push_failed", map[string]any{"vm": v.ID, "host": v.Host, "error": err.Error()})
	}
}

// RunningHost resolves the current boot of a running VM for session requests.
func (c *Controller) RunningHost(ctx context.Context, v VM) (Host, error) {
	if v.Phase != Running {
		return Host{}, ErrPhase
	}
	h, err := c.Host(ctx, v.Pool, v.Host)
	if errors.Is(err, ErrNotFound) {
		return Host{}, ErrPhase
	}
	if err != nil {
		return Host{}, err
	}
	if !v.onHost(h) || h.Lost || h.Restarting || h.LastSeenAt <= c.hostCutoff(c.now().UnixMilli()) {
		return Host{}, ErrPhase
	}
	return h, nil
}
