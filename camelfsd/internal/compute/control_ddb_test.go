package compute

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"slices"
	"testing"
	"time"
)

func TestDDBMemoryCapacity(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.register("memory", "boot", 4)
	for i, mem := range []int{4096, 4096, 1024} {
		req := f.request(fmt.Sprint(i), "memory")
		req.Shape.MemoryMiB = mem
		must[VM](t)(f.Create(ctx, req))
		if i < 2 {
			must[VM](t)(f.Place(ctx, req.ID))
		} else if _, err := f.Place(ctx, req.ID); !errors.Is(err, ErrNoHost) {
			t.Fatalf("memory refusal: %v", err)
		}
	}
	f.checkHost("memory", 2, "0", "1")
	must[VM](t)(f.End(ctx, "0", EndRequest{Code: StartFailed, At: f.now}))
	f.checkHost("memory", 3, "1")
	must[VM](t)(f.Place(ctx, "2"))
	f.checkHost("memory", 2, "1", "2")
}

func TestDDBLoop(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	var events []string
	l := Loop{C: f.fresh(), Wait: time.Minute,
		Pools: func(context.Context) ([]string, error) { return []string{"queue", "idle", "lost"}, nil },
		Log:   func(event string, _ map[string]any) { events = append(events, event) }}
	f.register("lost", "boot", 1)
	lost := f.request("lost", "lost")
	for _, step := range f.startSteps(lost) {
		f.now = epoch.Add(step.offset)
		must[VM](t)(step.call(f.fresh()))
	}
	f.now = epoch.Add(time.Minute)
	must[VM](t)(f.Listed(ctx, lost.ID, "host", 1, f.now))
	lastListed := f.now.UnixMilli()

	f.now = epoch.Add(5 * time.Minute)
	expired := f.request("wait-expired", "queue")
	must[VM](t)(f.Create(ctx, expired))
	f.register("idle", "boot", 1)
	session := f.request("session", "idle")
	for _, step := range f.startSteps(session) {
		f.now = epoch.Add(5*time.Minute + step.offset)
		must[VM](t)(step.call(f.fresh()))
	}
	f.now = epoch.Add(6*time.Minute + time.Second)
	f.register("queue", "boot", 2)
	if err := f.Heartbeat(ctx, "idle", "host", 1, 0, f.now); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"too-big", "fits", "lease-expired"} {
		req := f.request(id, "queue")
		switch id {
		case "too-big":
			req.Shape.MemoryMiB = 9000
		case "lease-expired":
			req.Deadline = f.now.Add(time.Millisecond)
		}
		must[VM](t)(f.Create(ctx, req))
		f.now = f.now.Add(time.Millisecond)
	}
	cutoff := f.now.UnixMilli()
	for range 2 {
		if err := l.Pass(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if !slices.Equal(events, []string{"vm_wait_expired", "vm_placed", "vm_lease_expired", "vm_idle", "host_lost"}) {
		t.Fatal(events)
	}
	for id, code := range map[string]EndCode{expired.ID: StartFailed, "lease-expired": LeaseExpired, lost.ID: HostLost} {
		v := must[VM](t)(f.Get(ctx, id))
		if v.Phase != Ended || v.Code != code {
			t.Fatalf("end: %+v", v)
		}
	}
	if v := must[VM](t)(f.Get(ctx, "fits")); v.Phase != Booting {
		t.Fatalf("placement: %+v", v)
	}
	f.assertOutcome(must[VM](t)(f.Get(ctx, lost.ID)), lastListed)
	h := must[[]Host](t)(f.Hosts(ctx, "lost"))[0]
	if !h.Draining {
		t.Fatal("lost host still eligible")
	}
	if got := f.register("lost", "boot", 1); got != 2 {
		t.Fatalf("registration epoch: %d", got)
	}
	if must[[]Host](t)(f.Hosts(ctx, "lost"))[0].Draining {
		t.Fatal("registration did not restore host")
	}

	f.now = f.now.Add(time.Second)
	v := must[VM](t)(f.End(ctx, session.ID, EndRequest{At: f.now, Code: Stopped}))
	// The idle stop bills to the idle deadline it enforced, not to when the sweep ran.
	cutoff = *v.LastActivityAt + v.Session.IdleStopS*1000
	if v.Code != Idle || v.StopRequestedAt == nil || *v.StopRequestedAt != cutoff || !v.StopCheckpoint {
		t.Fatalf("timeout: %+v", v)
	}
	f.assertOutcome(v, cutoff)
}

func TestDDBReconcile(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.register("reconcile", "boot", 1)
	id := "vm"
	must[VM](t)(f.Create(ctx, f.request(id, "reconcile")))
	must[VM](t)(f.Place(ctx, id))
	grace := 10 * time.Second
	c := f.fresh()
	reconcile := func(c *Controller, listed ...Listed) (Reconcile, error) {
		return c.Reconcile(ctx, "reconcile", "host", 1, 0, f.now, listed, grace)
	}
	c.afterWrite = func() error { return lostResponse }
	if _, err := reconcile(c); !errors.Is(err, lostResponse) {
		t.Fatalf("lost boot reply: %v", err)
	}
	if v := must[VM](t)(f.Get(ctx, id)); v.Phase != Booting {
		t.Fatalf("boot not durable: %s", v.Phase)
	}
	c = f.fresh()
	if reply := must[Reconcile](t)(reconcile(c)); len(reply.Boot) != 1 || reply.Boot[0].ID != id {
		t.Fatal(reply)
	}
	f.now = f.now.Add(grace + time.Millisecond)
	if reply := must[Reconcile](t)(reconcile(c)); len(reply.Boot) != 1 || reply.Boot[0].ID != id {
		t.Fatal(reply)
	}
	start := f.now
	for i := range 3 {
		f.now = start.Add(time.Duration(i) * time.Minute)
		if reply := must[Reconcile](t)(reconcile(c, Listed{ID: id, StartedAt: &start})); len(reply.Boot)+len(reply.Stop) != 0 {
			t.Fatal(reply)
		}
		v := must[VM](t)(f.Get(ctx, id))
		if v.UsageSeq != int64(i) || v.BilledTo != f.now.UnixMilli() {
			t.Fatalf("usage: %+v", v)
		}
	}
	listed := f.now.UnixMilli()
	f.now = f.now.Add(time.Minute)
	must[Reconcile](t)(reconcile(c, Listed{ID: id, Finished: true}))
	if v := must[VM](t)(f.Get(ctx, id)); v.Phase != Running || v.BilledTo != listed || *v.LastListedAt != listed {
		t.Fatalf("finished listing: %+v", v)
	}
	must[VM](t)(c.RequestStop(ctx, id, false))
	if reply := must[Reconcile](t)(reconcile(c, Listed{ID: id}, Listed{ID: "unknown"})); !slices.Equal(reply.Stop, []StopOrder{{ID: id}, {ID: "unknown"}}) {
		t.Fatal(reply)
	}
	must[Reconcile](t)(reconcile(c))
	v := must[VM](t)(f.Get(ctx, id))
	if v.Code != HostLost {
		t.Fatalf("missing VM: %+v", v)
	}
	// Heartbeat free was reported as zero before the end returned the slot.
	f.assertOutcome(v, listed)
	if reply := must[Reconcile](t)(reconcile(c, Listed{ID: id, Finished: true})); !slices.Equal(reply.Stop, []StopOrder{{ID: id}}) {
		t.Fatal(reply)
	}
	if _, err := c.Reconcile(ctx, "reconcile", "host", 0, 0, f.now, nil, grace); !errors.Is(err, ErrHost) {
		t.Fatalf("stale epoch: %v", err)
	}
}

func TestDDBReconcileEndInterleaving(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	rng := rand.New(rand.NewSource(17))
	for i := range 24 {
		f.now = epoch
		id := fmt.Sprint(i)
		f.register(id, "boot", 1)
		must[VM](t)(f.Create(ctx, f.request(id, id)))
		must[VM](t)(f.Place(ctx, id))
		c := f.fresh()
		end := func() { must[VM](t)(f.End(ctx, id, EndRequest{At: f.now, Code: Stopped})) }
		var listed []Listed
		switch i % 4 {
		case 0:
			// End after the heartbeat write, before its host snapshot is used.
			f.now = f.now.Add(time.Second)
			c.afterWrite = func() error { end(); return nil }
		case 1:
			// End after the boot transition commits, before the reply.
			c.afterWrite = func() error { end(); return nil }
		case 2:
			listed = []Listed{{ID: id}}
		case 3:
			end()
		}
		for range 1 + rng.Intn(5) {
			reply := must[Reconcile](t)(c.Reconcile(ctx, id, "host", 1, 0, f.now, listed, time.Second))
			if len(reply.Boot) != 0 {
				t.Fatalf("boot from stale or listed VM: %+v", reply)
			}
			c = f.fresh()
			if rng.Intn(2) == 0 {
				end()
			}
		}
		end()
	}
}

func TestDDBHostLossSweepYieldsToHeartbeat(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.register("pool", "boot", 2)
	for _, id := range []string{"a", "b"} {
		must[VM](t)(f.Create(ctx, f.request(id, "pool")))
		must[VM](t)(f.Place(ctx, id))
	}
	f.now = epoch.Add(6 * time.Minute)
	var ended string
	l := Loop{C: f.fresh(), Pools: func(context.Context) ([]string, error) { return []string{"pool"}, nil },
		Log: func(event string, fields map[string]any) {
			if event != "host_lost" || ended != "" {
				t.Fatalf("unexpected event: %s %v", event, fields)
			}
			ended = fields["vm"].(string)
			if err := f.Heartbeat(ctx, "pool", "host", 1, 1, f.now); err != nil {
				t.Fatal(err)
			}
		}}
	if err := l.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	h := must[[]Host](t)(f.Hosts(ctx, "pool"))[0]
	if ended == "" || h.Draining || len(h.VMs) != 1 || h.VMs[0] == ended {
		t.Fatalf("host after fresh heartbeat: %+v, ended %q", h, ended)
	}
	f.checkMemory(h)
}

func TestDDBBootTimeout(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.register("boot", "boot", 1)
	req := f.request("stuck", "boot")
	req.Deadline = epoch.Add(time.Hour)
	for _, step := range f.startSteps(req)[:3] { // create, place, booting: no start report
		f.now = epoch.Add(step.offset)
		must[VM](t)(step.call(f.fresh()))
	}
	var events []string
	l := &Loop{C: f.fresh(), Pools: func(context.Context) ([]string, error) { return []string{"boot"}, nil },
		Log: func(event string, _ map[string]any) { events = append(events, event) }}
	// Keep the host alive; before the boot timeout nothing happens.
	f.now = epoch.Add(4 * time.Minute)
	if err := f.Heartbeat(ctx, "boot", "host", 1, 0, f.now); err != nil {
		t.Fatal(err)
	}
	if err := l.Pass(ctx); err != nil || len(events) != 0 {
		t.Fatalf("early: %v %v", err, events)
	}
	f.now = epoch.Add(6 * time.Minute)
	if err := f.Heartbeat(ctx, "boot", "host", 1, 0, f.now); err != nil {
		t.Fatal(err)
	}
	if err := l.Pass(ctx); err != nil || !slices.Equal(events, []string{"vm_boot_timed_out"}) {
		t.Fatalf("timeout: %v %v", err, events)
	}
	v := must[VM](t)(f.Get(ctx, "stuck"))
	if v.Phase != Ended || v.Code != StartFailed {
		t.Fatalf("stuck boot: %+v", v)
	}
	f.assertOutcome(v, 0) // no usage: it never started
	reply := must[Reconcile](t)(f.Reconcile(ctx, "boot", "host", 1, 0, f.now.Add(time.Second), []Listed{{ID: "stuck"}}, time.Minute))
	if !slices.Equal(reply.Stop, []StopOrder{{ID: "stuck"}}) {
		t.Fatalf("a late boot is stopped: %+v", reply)
	}
}

func TestDDBIdleWaitsForAllExecs(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	req := f.request("session", "pool")
	f.register("pool", "boot", 1)
	for _, step := range f.startSteps(req) {
		f.now = epoch.Add(step.offset)
		must[VM](t)(step.call(f.fresh()))
	}
	l := Loop{C: &f.Controller, Pools: func(context.Context) ([]string, error) { return []string{"pool"}, nil }}
	var firstLogs int
	f.Log = func(event string, fields map[string]any) {
		if event == "vm_first_exec" {
			firstLogs++
			if fields["latencyMs"] != f.now.Sub(epoch).Milliseconds() {
				t.Fatal(fields)
			}
		}
	}
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	f.now = f.now.Add(time.Second)
	check(f.ExecStarted(ctx, req.ID, "a", f.now))
	check(f.ExecStarted(ctx, req.ID, "a", f.now))
	check(f.ExecStarted(ctx, req.ID, "b", f.now))
	f.now = f.now.Add(30 * time.Second)
	check(f.ExecEnded(ctx, req.ID, "a", f.now))
	check(f.ExecStarted(ctx, req.ID, "a", f.now))
	check(f.ExecEnded(ctx, req.ID, "a", f.now))
	f.now = f.now.Add(30 * time.Second)
	check(l.Pass(ctx))
	v := must[VM](t)(f.Get(ctx, req.ID))
	if v.Phase != Running || !slices.Equal(v.execs, []string{"b"}) || firstLogs != 1 {
		t.Fatalf("running VM: %+v, first-exec logs: %d", v, firstLogs)
	}
	check(f.ExecEnded(ctx, req.ID, "b", f.now))
	f.now = f.now.Add(DefaultIdleStopS * time.Second)
	check(f.ExecEnded(ctx, req.ID, "b", f.now))
	check(f.Touch(ctx, req.ID, f.now.Add(-time.Minute)))
	check(l.Pass(ctx))
	if v := must[VM](t)(f.Get(ctx, req.ID)); v.Phase != Running {
		t.Fatal(v.Phase)
	}
	f.now = f.now.Add(time.Millisecond)
	check(l.Pass(ctx))
	cutoff := f.now.UnixMilli()
	f.now = f.now.Add(time.Second)
	v = must[VM](t)(f.End(ctx, req.ID, EndRequest{At: f.now, Code: Stopped}))
	if want := *v.LastActivityAt + v.Session.IdleStopS*1000; want >= cutoff {
		t.Fatalf("idle deadline %d not before the sweep %d", want, cutoff)
	} else {
		cutoff = want
	}
	if v.Code != Idle || !v.StopCheckpoint || *v.StopRequestedAt != cutoff || len(v.execs) != 0 {
		t.Fatalf("idle VM: %+v", v)
	}
	f.assertOutcome(v, cutoff)
}

func TestDDBExecTrackingIsBounded(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	req := f.request("session", "pool")
	f.register("pool", "boot", 1)
	for _, step := range f.startSteps(req) {
		f.now = epoch.Add(step.offset)
		must[VM](t)(step.call(f.fresh()))
	}
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	row := func() item {
		return must[item](t)(f.read(ctx, f.Tables.VMs, vmKey(req.ID)))
	}
	original := row()
	// A session already touched by b9d57f3a may have historical exec IDs.
	_, err := f.updateVM(ctx, req.ID, "#phase = :running", "ADD #seenExecs :seen",
		attrs{":running": s(string(Running)), ":seen": ss("completed")})
	check(err)
	for i := range 1000 {
		id := fmt.Sprintf("sequential-%04d", i)
		at := f.now.Add(time.Duration(i) * time.Millisecond)
		check(f.ExecStarted(ctx, req.ID, id, at))
		check(f.ExecEnded(ctx, req.ID, id, at))
	}
	after := row()
	if after["execs"] != nil || after["seenExecs"] != nil || len(after) != len(original)+1 || after["firstExecAt"] == nil {
		t.Fatalf("sequential execs grew the VM row: %d attributes before, %d after", len(original), len(after))
	}
	for i := range maxExecsInFlight - 1 {
		check(f.ExecStarted(ctx, req.ID, fmt.Sprintf("active-%d", i), f.now))
	}
	results := make(chan error, 2)
	for _, id := range []string{"last-a", "last-b"} {
		go func() { results <- f.ExecStarted(ctx, req.ID, id, f.now) }()
	}
	var refused int
	for range 2 {
		if err := <-results; errors.Is(err, ErrTooManyExecs) {
			refused++
		} else {
			check(err)
		}
	}
	if refused != 1 || len(row().set("execs")) != maxExecsInFlight {
		t.Fatalf("concurrent final slot: %d refused", refused)
	}
	check(f.ExecStarted(ctx, req.ID, "active-0", f.now))
	check(f.ExecEnded(ctx, req.ID, "absent", f.now))
	if len(row().set("execs")) != maxExecsInFlight {
		t.Fatal("duplicate start or absent end changed the set")
	}
	check(f.ExecEnded(ctx, req.ID, "active-0", f.now))
	check(f.ExecStarted(ctx, req.ID, "active-0", f.now))
	if len(row().set("execs")) != maxExecsInFlight {
		t.Fatal("reattachment did not reclaim a slot")
	}
}

func TestDDBUnplaceable(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	var reasons []string
	var events []string
	f.Log = func(event string, fields map[string]any) {
		if event == "vm_unplaceable" {
			reasons = append(reasons, fields["vm"].(string)+":"+fields["reason"].(string))
		}
	}
	l := Loop{C: &f.Controller, Wait: 90 * time.Second,
		Pools: func(context.Context) ([]string, error) { return []string{"queue"}, nil },
		Log:   func(event string, fields map[string]any) { events = append(events, event+":"+fields["vm"].(string)) }}
	f.HostFresh = 3 * time.Minute
	f.register("queue", "boot", 1)
	create := func(id string, mem int) {
		req := f.request(id, "queue")
		req.Shape.MemoryMiB = mem
		must[VM](t)(l.Create(ctx, req))
	}
	pass := func(offset time.Duration) {
		t.Helper()
		f.now = epoch.Add(offset)
		if err := l.Pass(ctx); err != nil {
			t.Fatal(err)
		}
	}
	check := func(id string, phase Phase, reason string) {
		t.Helper()
		v := must[VM](t)(f.Get(ctx, id))
		if v.Phase != phase || v.Reason != reason || (phase == Ended && v.Code != StartFailed) {
			t.Fatalf("unexpected phase or end: %+v", v)
		}
	}
	create("a-unfit", 9000)
	create("b-fits", 1024)
	create("c-full", 1024)
	create("d-fits", 1024)
	if !slices.Equal(reasons, []string{"a-unfit:no_host_fits"}) {
		t.Fatal(reasons)
	}
	pass(0)
	check("a-unfit", Requested, "")
	check("b-fits", Booting, "")
	check("c-full", Requested, "")
	check("d-fits", Requested, "")
	pass(29 * time.Second)
	if !slices.Equal(reasons, []string{"a-unfit:no_host_fits", "c-full:full", "d-fits:full"}) {
		t.Fatal(reasons)
	}
	pass(30 * time.Second)
	check("a-unfit", Ended, "no_host_fits")
	if !slices.Contains(events, "vm_unfit_ended:a-unfit") || len(l.unplaceable["queue"]) != 2 {
		t.Fatalf("events=%v rate limit=%v", events, l.unplaceable)
	}
	pass(60 * time.Second)
	check("c-full", Requested, "")
	if !slices.Equal(reasons, []string{"a-unfit:no_host_fits", "c-full:full", "d-fits:full", "c-full:full", "d-fits:full"}) {
		t.Fatal(reasons)
	}
	pass(91 * time.Second)
	check("c-full", Ended, "no_capacity")
	check("d-fits", Ended, "no_capacity")
}

func TestDDBUnfitHostArrives(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.register("queue", "boot", 1)
	l := Loop{C: &f.Controller, Pools: func(context.Context) ([]string, error) { return []string{"queue"}, nil }}
	req := f.request("unfit", "queue")
	req.Shape.MemoryMiB = 9000
	must[VM](t)(l.Create(ctx, req))
	if err := l.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(29 * time.Second)
	must[int64](t)(f.Register(ctx, HostInfo{Pool: "queue", Host: "new", BootID: "boot", Slots: 1, Shape: req.Shape}))
	if err := l.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	if v := must[VM](t)(f.Get(ctx, req.ID)); v.Phase != Booting || v.Host != "new" {
		t.Fatal(v)
	}
}

func TestDDBReregisterCapacity(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.register("queue", "boot", 1)
	req := f.request("vm", "queue")
	must[VM](t)(f.Create(ctx, req))
	must[VM](t)(f.Place(ctx, req.ID))
	h := must[Host](t)(f.Host(ctx, "queue", "host"))
	info := h.HostInfo
	info.Slots += 2
	info.Shape.MemoryMiB += 2048
	info.Shape.VCPUs += 2
	if got := must[int64](t)(f.Register(ctx, info)); got != h.BootEpoch {
		t.Fatal(got)
	}
	updated := must[Host](t)(f.Host(ctx, "queue", "host"))
	if updated.Shape != info.Shape || updated.Slots != info.Slots || updated.Free != h.Free+2 || updated.FreeMiB != h.FreeMiB+2048 {
		t.Fatal(updated)
	}
	f.checkHost("queue", 2, req.ID)

	shrink := info
	shrink.Slots = 0
	if _, err := f.Register(ctx, shrink); !errors.Is(err, ErrCapacityInUse) {
		t.Fatalf("slot shrink: %v", err)
	}
	shrink = info
	shrink.Shape.MemoryMiB = req.Shape.MemoryMiB - 1
	if _, err := f.Register(ctx, shrink); !errors.Is(err, ErrCapacityInUse) {
		t.Fatalf("memory shrink: %v", err)
	}
	f.checkHost("queue", 2, req.ID)
	shrink.BootID = "new-boot"
	if got := must[int64](t)(f.Register(ctx, shrink)); got != h.BootEpoch+1 {
		t.Fatal(got)
	}
	f.checkHost("queue", shrink.Slots)
	if v := must[VM](t)(f.Get(ctx, req.ID)); v.Phase != Ended || v.Code != HostLost {
		t.Fatal(v)
	}
}
