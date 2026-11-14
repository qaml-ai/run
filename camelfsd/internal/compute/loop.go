package compute

import (
	"context"
	"errors"
	"time"
)

// Loop runs one tier node's share of background work. Item conditions
// arbitrate concurrent passes from different nodes.
type Loop struct {
	C        *Controller
	Pools    func(context.Context) ([]string, error)
	Now      func() time.Time
	Period   time.Duration
	HostLost time.Duration
	Wait     time.Duration
	Log      func(event string, fields map[string]any)
}

func (l *Loop) Run(ctx context.Context) error {
	period := l.Period
	if period <= 0 {
		period = 2 * time.Second
	}
	ticker := time.NewTicker(period)
	defer ticker.Stop()
	for ctx.Err() == nil {
		if err := l.Pass(ctx); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
	return ctx.Err()
}

func (l *Loop) Pass(ctx context.Context) error {
	pools, err := l.Pools(ctx)
	if err != nil {
		return err
	}
	now := l.C.now()
	if l.Now != nil {
		now = l.Now()
	}
	var result error
	for _, pool := range pools {
		result = errors.Join(result, l.passPool(ctx, pool, now))
	}
	return result
}

func (l *Loop) passPool(ctx context.Context, pool string, now time.Time) error {
	result := l.placeWaiters(ctx, pool, now)
	hosts, err := l.C.Hosts(ctx, pool)
	if err != nil {
		return errors.Join(result, err)
	}
	lost := l.HostLost
	if lost <= 0 {
		lost = 5 * time.Minute
	}
	cutoff := now.Add(-lost).UnixMilli()
	for _, h := range hosts {
		if !h.Restarting && h.LastSeenAt < cutoff {
			result = errors.Join(result, l.loseHost(ctx, h, now))
		}
	}
	for _, h := range hosts {
		if !h.Restarting && h.LastSeenAt >= cutoff {
			result = errors.Join(result, l.sweepVMs(ctx, h, now))
		}
	}
	return result
}

func (l *Loop) placeWaiters(ctx context.Context, pool string, now time.Time) error {
	wait := l.Wait
	if wait <= 0 {
		wait = 10 * time.Minute
	}
	waiters, err := l.C.Waiting(ctx, pool)
	if err != nil {
		return err
	}
	placementBlocked := false
	for _, w := range waiters {
		v, err := l.C.Get(ctx, w.VM)
		if err != nil {
			return err
		}
		if v.Phase != Requested {
			continue
		}
		var event string
		switch {
		case v.CreatedAt < now.Add(-wait).UnixMilli():
			event = "vm_wait_expired"
			_, err = l.C.end(ctx, v, EndRequest{At: now, Code: StartFailed}, now, nil)
		case v.LeaseDeadline <= now.UnixMilli():
			event = "vm_lease_expired"
			_, err = l.C.stop(ctx, v, now, v.LeaseDeadline, LeaseExpired, true)
		case !placementBlocked:
			event = "vm_placed"
			_, err = l.C.place(ctx, v, now.UnixMilli())
			if errors.Is(err, ErrNoHost) || errors.Is(err, ErrCondition) {
				placementBlocked = true
				continue
			}
		default:
			continue
		}
		if err := l.record(event, v.ID, err); err != nil {
			return err
		}
	}
	return nil
}

func (l *Loop) loseHost(ctx context.Context, h Host, now time.Time) error {
	var result error
	for _, id := range h.VMs {
		v, err := l.C.Get(ctx, id)
		if err == nil && v.onHost(h) && v.Phase != Ended {
			_, err = l.C.endWithHostSnapshot(ctx, v, EndRequest{Code: HostLost}, now, nil, &h)
			err = l.record("host_lost", id, err)
		}
		result = errors.Join(result, err)
	}
	// The empty-set condition also lets a later pass finish draining after a
	// crash between the last end and this write.
	if result != nil || h.lost {
		return result
	}
	_, err := l.C.update(ctx, change(l.C.Tables.Hosts, hostKey(h.Pool, h.Host),
		"#bootEpoch = :epoch AND #lastSeenAt = :seen AND attribute_not_exists(#vms) AND attribute_not_exists(#lost)",
		"SET #draining = :true, #lost = :true",
		attrs{":epoch": n(h.BootEpoch), ":seen": n(h.LastSeenAt), ":true": b(true)}))
	if errors.Is(err, ErrCondition) {
		return nil
	}
	return err
}

func (l *Loop) sweepVMs(ctx context.Context, h Host, now time.Time) error {
	var result error
	for _, id := range h.VMs {
		v, err := l.C.Get(ctx, id)
		if err != nil {
			result = errors.Join(result, err)
			continue
		}
		if !v.onHost(h) || v.Phase == Ended || v.Phase == Stopping {
			continue
		}
		switch {
		case v.LeaseDeadline <= now.UnixMilli():
			_, err = l.C.stop(ctx, v, now, v.LeaseDeadline, LeaseExpired, true)
			result = errors.Join(result, l.record("vm_lease_expired", id, err))
		case v.Mode == JobMode && v.Phase == Running && v.DeadlineAt != nil && *v.DeadlineAt <= now.UnixMilli():
			// MONEY: like a lease stop, a timeout stop bills to the deadline it enforces (startedAt + timeoutS + grace),
			// never to whenever this sweep happened to run.
			_, err = l.C.stop(ctx, v, now, *v.DeadlineAt, Timeout, false)
			result = errors.Join(result, l.record("vm_timed_out", id, err))
		}
	}
	return result
}

func (l *Loop) record(event, id string, err error) error {
	if errors.Is(err, ErrCondition) {
		return nil
	}
	if err == nil && l.Log != nil {
		l.Log(event, map[string]any{"vm": id})
	}
	return err
}
