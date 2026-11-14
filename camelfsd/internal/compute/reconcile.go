package compute

import (
	"context"
	"errors"
	"time"
)

// Listed is a VM the host still holds, including finished VMs whose end has
// yet to be acknowledged. The host sends one heartbeat at a time and refuses
// to boot an ID while it retains that VM's record.
type Listed struct {
	ID        string
	StartedAt *time.Time
	Finished  bool
}

// Reconcile carries instructions for the boot epoch named by the request.
type Reconcile struct {
	Stop []string
	Boot []VM
}

// Reconcile applies one heartbeat. The host sends one heartbeat at a time,
// applies its reply only to the request's boot epoch, and keeps each VM's
// record until its end is acknowledged, refusing to boot that ID meanwhile.
func (c *Controller) Reconcile(ctx context.Context, pool, host string, bootEpoch int64, free int, at time.Time, running []Listed, grace time.Duration) (Reconcile, error) {
	h, at, err := c.heartbeat(ctx, pool, host, bootEpoch, free, at)
	if errors.Is(err, ErrNotFound) {
		return Reconcile{}, ErrHost
	}
	if err != nil {
		return Reconcile{}, err
	}
	var reply Reconcile
	present := make(map[string]bool, len(running))
	for _, entry := range running {
		if present[entry.ID] {
			continue
		}
		present[entry.ID] = true
		stop, err := c.reconcileListed(ctx, h, at, entry)
		if err != nil {
			return Reconcile{}, err
		}
		if stop {
			reply.Stop = append(reply.Stop, entry.ID)
		}
	}
	cutoff := at.Add(-grace).UnixMilli()
	for _, id := range h.VMs {
		if present[id] {
			continue
		}
		v, err := c.Get(ctx, id)
		if err != nil {
			return Reconcile{}, err
		}
		if !v.onHost(h) {
			continue
		}
		switch v.Phase {
		case Placed:
			v, err = c.markBooting(ctx, v)
			if err == nil && v.onHost(h) && v.Phase == Booting {
				c.pushBoot(ctx, v)
				v, err = c.Get(ctx, id)
				if err == nil && v.onHost(h) && v.Phase == Booting {
					reply.Boot = append(reply.Boot, v)
				}
			}
		case Booting:
			if v.LeaseDeadline > c.now().UnixMilli() && (c.Refs == nil || v.RefLeaseDeadline > c.now().UnixMilli()) {
				reply.Boot = append(reply.Boot, v)
			}
		case Running, Stopping:
			if missingSince(v, cutoff) {
				_, err = c.endWithHostSnapshot(ctx, v, EndRequest{Code: HostLost}, c.now(), nil, &h)
			}
		}
		if err != nil && !errors.Is(err, ErrCondition) && !errors.Is(err, ErrClockSkew) {
			return Reconcile{}, err
		}
	}
	current, err := c.Host(ctx, pool, host)
	if err != nil {
		return Reconcile{}, err
	}
	if current.BootEpoch != bootEpoch || current.Lost || current.Restarting {
		return Reconcile{}, ErrHost
	}
	return reply, nil
}

func (v VM) onHost(h Host) bool {
	return v.Pool == h.Pool && v.Host == h.Host && v.HostEpoch == h.BootEpoch
}

func missingSince(v VM, cutoff int64) bool {
	for _, at := range []*int64{v.LastListedAt, v.StartedAt, v.BootingAt} {
		if at != nil {
			return *at < cutoff
		}
	}
	return false
}

func (c *Controller) reconcileListed(ctx context.Context, h Host, at time.Time, entry Listed) (bool, error) {
	v, err := c.Get(ctx, entry.ID)
	if errors.Is(err, ErrNotFound) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	if !v.onHost(h) || v.Phase == Ended || v.Phase == Stopping {
		return true, nil
	}
	if entry.Finished {
		return false, nil
	}
	if entry.StartedAt != nil && v.StartedAt == nil {
		v, err = c.StartedFromHost(ctx, v.ID, h, *entry.StartedAt)
		if err != nil {
			return false, err
		}
		if v.Phase == Ended || v.Phase == Stopping {
			return true, nil
		}
	}
	v, err = c.Listed(ctx, v.ID, h.Host, h.BootEpoch, at)
	// MONEY: keep delivering heartbeat instructions while usage waits for the clock.
	if errors.Is(err, ErrClockSkew) {
		return false, nil
	}
	return v.Phase == Ended || v.Phase == Stopping, err
}
