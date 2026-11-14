package compute

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/delivery"
)

type endedEvent struct {
	ID              string  `json:"id"`
	Type            string  `json:"type"`
	VM              string  `json:"vm"`
	Code            EndCode `json:"code"`
	Exit            int     `json:"exit"`
	TimedOut        bool    `json:"timedOut"`
	ResultRef       string  `json:"resultRef"`
	Version         string  `json:"version,omitempty"`
	CheckpointError string  `json:"checkpointError,omitempty"`
}

func (c *Controller) End(ctx context.Context, id string, end EndRequest) (VM, error) {
	v, err := c.Get(ctx, id)
	if err != nil || v.Phase == Ended {
		return v, err
	}
	ended, err := c.end(ctx, v, end, c.now(), nil)
	if errors.Is(err, ErrCondition) {
		if current, readErr := c.Get(ctx, id); readErr == nil && current.Phase == Ended {
			return current, nil
		}
	}
	return ended, err
}

func (c *Controller) end(ctx context.Context, v VM, end EndRequest, now time.Time, stop *stopIntent) (VM, error) {
	cond := "#phase = :phase AND #leaseDeadline = :lease"
	expr := "SET #phase = :ended, #endedAt = :at, #code = :code, #exit = :exit, #timedOut = :timedOut, " +
		"#resultRef = :resultRef, #endVersion = :version, #checkpointError = :checkpointError"
	values := attrs{":phase": s(string(v.Phase)), ":ended": s(string(Ended)), ":lease": n(v.LeaseDeadline),
		":exit": n(int64(end.Exit)), ":timedOut": b(end.TimedOut), ":resultRef": s(end.ResultRef),
		":version": s(end.EndVersion), ":checkpointError": s(end.CheckpointError)}
	at := end.At.UnixMilli()
	switch end.Code {
	case HostLost:
		// A VM never listed has no confirmed runtime after its start report.
		switch {
		case v.LastListedAt != nil:
			at = *v.LastListedAt
			cond += " AND #lastListedAt = :at"
		case v.StartedAt != nil:
			at = *v.StartedAt
			cond += " AND attribute_not_exists(#lastListedAt)"
		default:
			at = now.UnixMilli()
			cond += " AND attribute_not_exists(#lastListedAt)"
		}
	case Stopped:
		if v.StopReason == LeaseExpired {
			end.Code = LeaseExpired
		}
	case Exit, Timeout, StartFailed, LeaseExpired:
	default:
		return v, ErrInvalid
	}
	// MONEY: a host-reported end is never later than the tier's own clock.
	at = min(at, now.UnixMilli())
	values[":at"], values[":code"] = n(at), s(string(end.Code))
	if stop != nil {
		expr += ", #stopRequestedAt = :stop, #stopCheckpoint = :checkpoint, #stopReason = :reason"
		values[":stop"], values[":checkpoint"], values[":reason"] = n(stop.at), b(stop.checkpoint), s(string(stop.reason))
	}

	// MONEY: End and interval extension compete on the same seq/from pair.
	// Also fence a late start report on a VM already in stopping.
	event := usageInterval(v, at, true)
	if event == nil {
		cond += " AND attribute_not_exists(#startedAt)"
	} else {
		cond += " AND " + usageCAS
		expr += ", #billedTo = :to, #usageSeq = :next"
		values[":seq"], values[":from"] = n(v.UsageSeq), n(v.BilledTo)
		values[":to"], values[":next"] = n(event.To), n(v.UsageSeq+1)
	}

	writes := []types.TransactWriteItem{{Update: change(c.Tables.VMs, vmKey(v.ID), cond, expr, values)}}
	switch {
	case v.Phase == Requested:
		writes = append(writes, c.deleteWaiter(v))
	case v.Host != "":
		host := change(c.Tables.Hosts, hostKey(v.Pool, v.Host), "contains(#vms, :id)",
			"SET #free = #free + :one DELETE #vms :vm",
			attrs{":id": s(v.ID), ":one": n(1), ":vm": ss(v.ID)})
		writes = append(writes, types.TransactWriteItem{Update: host})
	}

	id := "vm.ended:" + v.ID
	body, err := json.Marshal(endedEvent{ID: id, Type: "vm.ended", VM: v.ID, Code: end.Code,
		Exit: end.Exit, TimedOut: end.TimedOut, ResultRef: end.ResultRef, Version: end.EndVersion,
		CheckpointError: end.CheckpointError})
	if err != nil {
		return VM{}, err
	}
	staged, err := delivery.Stage(c.Tables.Deliveries, delivery.Delivery{ID: id, URL: c.RuntimeURL, Body: body}, now)
	if err != nil {
		return VM{}, err
	}
	if err := c.writeWithUsage(ctx, event, v.UsageSeq, append(writes, staged)...); err != nil {
		return VM{}, err
	}
	return c.Get(ctx, v.ID)
}
