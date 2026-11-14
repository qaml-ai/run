package compute

import (
	"context"
	"errors"
	"maps"
	"sync"
	"time"
)

// Loop runs one tier node's share of background work. Item conditions
// arbitrate concurrent passes from different nodes.
type Loop struct {
	C          *Controller
	Pools      func(context.Context) ([]string, error)
	Now        func() time.Time
	Period     time.Duration
	HostLost   time.Duration
	Enrollment bool
	Wait       time.Duration
	// UnfitGrace is the maximum age of a waiter with no matching host (default 30 s).
	UnfitGrace  time.Duration
	logMu       sync.Mutex
	unplaceable map[string]map[string]placementLog
	// BootTimeout ends a VM that stayed booting (no start report) this long as start_failed (default 5 min). It is
	// never billed: usage needs startedAt. A host that later lists it gets it in Stop.
	BootTimeout time.Duration
	Log         func(event string, fields map[string]any)
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
			l.C.log("compute_pass_failed", map[string]any{"error": err.Error()})
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
		if l.Enrollment {
			result = errors.Join(result, l.C.expireEnrollments(ctx, pool, now))
		}
		result = errors.Join(result, l.passPool(ctx, pool, now))
	}
	return result
}

func (l *Loop) passPool(ctx context.Context, pool string, now time.Time) error {
	result := errors.Join(l.C.pendingReleases(ctx, pool), l.placeWaiters(ctx, pool, now))
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

type placementLog struct {
	reason string
	at     time.Time
}

const noHostFits = "no_host_fits"

// Create logs a newly requested VM's capacity problem before its first placement pass.
func (l *Loop) Create(ctx context.Context, req CreateRequest) (VM, error) {
	v, err := l.C.Create(ctx, req)
	if err != nil || v.Phase != Requested {
		return v, err
	}
	now := l.C.now()
	hosts, err := l.C.Hosts(ctx, v.Pool)
	if err != nil {
		l.C.log("vm_capacity_check_failed", map[string]any{"vm": v.ID, "pool": v.Pool, "error": err.Error()})
		return v, nil
	}
	if fits, live, best, _ := placementCapacity(hosts, v.Shape, l.C.hostCutoff(now.UnixMilli())); !fits {
		l.logUnplaceable(v, noHostFits, now, live, best)
	}
	return v, nil
}

func logShape(shape Shape) map[string]int {
	return map[string]int{"vcpus": shape.VCPUs, "memoryMiB": shape.MemoryMiB, "diskMiB": shape.diskMiB()}
}

func (l *Loop) logUnplaceable(v VM, reason string, now time.Time, live int, best *Host) {
	l.logMu.Lock()
	defer l.logMu.Unlock()
	if l.unplaceable == nil {
		l.unplaceable = make(map[string]map[string]placementLog)
	}
	entries := l.unplaceable[v.Pool]
	if entries == nil {
		entries = make(map[string]placementLog)
		l.unplaceable[v.Pool] = entries
	}
	if prev := entries[v.ID]; prev.reason == reason && now.Sub(prev.at) < time.Minute {
		return
	}
	entries[v.ID] = placementLog{reason, now}
	var closest map[string]any
	if best != nil {
		closest = map[string]any{"id": best.Host, "shape": logShape(best.Shape), "free": best.Free, "freeMiB": best.FreeMiB}
	}
	l.C.log("vm_unplaceable", map[string]any{"vm": v.ID, "pool": v.Pool, "shape": logShape(v.Shape),
		"reason": reason, "hosts": live, "best": closest})
}

func (l *Loop) placeWaiters(ctx context.Context, pool string, now time.Time) error {
	wait, grace := l.Wait, l.UnfitGrace
	if wait <= 0 {
		wait = 10 * time.Minute
	}
	if grace <= 0 || grace >= 60*time.Second {
		grace = 30 * time.Second
	}
	l.logMu.Lock()
	prior := maps.Clone(l.unplaceable[pool])
	l.logMu.Unlock()
	waiters, err := l.C.Waiting(ctx, pool)
	if err != nil {
		return err
	}
	defer func() {
		l.logMu.Lock()
		defer l.logMu.Unlock()
		for id, entry := range prior {
			if l.unplaceable[pool][id] == entry {
				delete(l.unplaceable[pool], id)
			}
		}
	}()
	for _, w := range waiters {
		delete(prior, w.VM)
	}
	placementBlocked := false
	for _, w := range waiters {
		v, err := l.C.Get(ctx, w.VM)
		if err != nil {
			return err
		}
		if v.Phase != Requested {
			l.forgetWaiter(pool, w.VM)
			continue
		}
		hosts, err := l.C.Hosts(ctx, pool)
		if err != nil {
			return err
		}
		fits, live, largest, freest := placementCapacity(hosts, v.Shape, l.C.hostCutoff(now.UnixMilli()))
		age := now.Sub(time.UnixMilli(v.CreatedAt))
		if !fits {
			l.logUnplaceable(v, noHostFits, now, live, largest)
		} else if placementBlocked || age > wait {
			// A fitting waiter can be behind an older one even when a host has room for it.
			if len(rankImage(hosts, v.Shape, l.C.hostCutoff(now.UnixMilli()), v.Image)) == 0 {
				l.logUnplaceable(v, "full", now, live, freest)
			}
		}
		var event string
		switch {
		case !fits && age >= grace:
			event = "vm_unfit_ended"
			_, err = l.C.end(ctx, v, EndRequest{At: now, Code: StartFailed, Reason: noHostFits}, now, nil)
		case fits && age > wait:
			event = "vm_wait_expired"
			_, err = l.C.end(ctx, v, EndRequest{At: now, Code: StartFailed, Reason: "no_capacity"}, now, nil)
		case v.LeaseDeadline <= now.UnixMilli():
			event = "vm_lease_expired"
			_, err = l.C.stop(ctx, v, now, v.LeaseDeadline, LeaseExpired, true)
		case !fits || placementBlocked:
			continue
		default:
			event = "vm_placed"
			var placed VM
			placed, err = l.C.placeOnHosts(ctx, v, now.UnixMilli(), hosts)
			if errors.Is(err, ErrNoHost) || errors.Is(err, ErrCondition) {
				if errors.Is(err, ErrNoHost) {
					l.logUnplaceable(v, "full", now, live, freest)
				}
				placementBlocked = true
				continue
			}
			if err == nil && placed.Phase == Placed {
				l.forgetWaiter(pool, v.ID)
				placed, err = l.C.markBooting(ctx, placed)
				if err == nil {
					l.C.pushBoot(ctx, placed)
				}
			}
		}
		if err == nil {
			l.forgetWaiter(pool, v.ID)
		}
		if err := l.record(event, v.ID, err); err != nil {
			return err
		}
	}
	return nil
}

func (l *Loop) forgetWaiter(pool, id string) {
	l.logMu.Lock()
	defer l.logMu.Unlock()
	delete(l.unplaceable[pool], id)
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
	if result != nil || h.Lost {
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
		if !v.onHost(h) || v.Phase == Ended {
			continue
		}
		if v.Phase == Booting || v.Phase == Running || v.Phase == Stopping {
			renewErr := l.C.renewRef(ctx, v, now)
			if !errors.Is(renewErr, ErrCondition) {
				result = errors.Join(result, renewErr)
			}
		}
		if v.Phase == Stopping {
			continue
		}
		boot := l.BootTimeout
		if boot <= 0 {
			boot = 5 * time.Minute
		}
		switch {
		case v.Phase == Booting && v.StartedAt == nil && v.BootingAt != nil && *v.BootingAt < now.Add(-boot).UnixMilli():
			_, err = l.C.endWithHostSnapshot(ctx, v, EndRequest{At: now, Code: StartFailed, Reason: "boot_timeout"}, now, nil, &h)
			result = errors.Join(result, l.record("vm_boot_timed_out", id, err))
			if err == nil && l.C.Pusher != nil {
				if pushErr := l.C.Pusher.Stop(ctx, h, id, false); pushErr != nil {
					l.C.log("host_stop_push_failed", map[string]any{"vm": id, "host": h.Host, "error": pushErr.Error()})
				}
			}
		case v.LeaseDeadline <= now.UnixMilli():
			_, err = l.C.stop(ctx, v, now, v.LeaseDeadline, LeaseExpired, true)
			result = errors.Join(result, l.record("vm_lease_expired", id, err))
		case v.Phase == Running && v.Session != nil && v.LastActivityAt != nil && len(v.execs) == 0 &&
			now.UnixMilli()-*v.LastActivityAt > v.Session.IdleStopS*1000:
			// MONEY: Idle teardown is billed only through the durable stop request, and to the idle deadline it enforces
			// (last activity + idleStopS), never to whenever this sweep ran.
			_, err = l.C.stop(ctx, v, now, *v.LastActivityAt+v.Session.IdleStopS*1000, Idle, true)
			result = errors.Join(result, l.record("vm_idle", id, err))
		}
	}
	return result
}

func (l *Loop) record(event, id string, err error) error {
	if errors.Is(err, ErrCondition) {
		return nil
	}
	if err == nil {
		if l.Log != nil {
			l.Log(event, map[string]any{"vm": id})
		} else {
			l.C.log(event, map[string]any{"vm": id})
		}
	}
	return err
}

// EndDeletedWaiters is best-effort cleanup after a ref or lineage deletion.
func (c *Controller) EndDeletedWaiters(ctx context.Context, pools []string, lineage, ref, reason string) {
	now := c.now()
	logFailure := func(pool, id string, err error) {
		c.log("vm_delete_cleanup_failed", map[string]any{"vm": id, "pool": pool, "lineage": lineage, "ref": ref,
			"reason": reason, "error": err.Error()})
	}
	for _, pool := range pools {
		waiters, err := c.Waiting(ctx, pool)
		if err != nil {
			logFailure(pool, "", err)
			continue
		}
		for _, w := range waiters {
			v, err := c.Get(ctx, w.VM)
			if err == nil && v.Lineage == lineage && (ref == "" || v.Ref == ref) {
				switch v.Phase {
				case Requested, Placed:
					_, err = c.end(ctx, v, EndRequest{At: now, Code: StartFailed, Reason: reason}, now, nil)
				}
			}
			if err != nil {
				logFailure(pool, w.VM, err)
			}
		}
	}
}
