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
		Pools: func(context.Context) ([]string, error) { return []string{"queue", "timeout", "lost"}, nil },
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
	f.register("timeout", "boot", 1)
	job := f.request("job", "timeout")
	job.Job.TimeoutS = 1
	for _, step := range f.startSteps(job) {
		f.now = epoch.Add(5*time.Minute + step.offset)
		must[VM](t)(step.call(f.fresh()))
	}
	f.now = epoch.Add(6*time.Minute + time.Second)
	f.register("queue", "boot", 2)
	if err := f.Heartbeat(ctx, "timeout", "host", 1, 0, f.now); err != nil {
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
	if !slices.Equal(events, []string{"vm_wait_expired", "vm_lease_expired", "vm_timed_out", "host_lost"}) {
		t.Fatal(events)
	}
	for id, code := range map[string]EndCode{expired.ID: StartFailed, "lease-expired": LeaseExpired, lost.ID: HostLost} {
		v := must[VM](t)(f.Get(ctx, id))
		if v.Phase != Ended || v.Code != code {
			t.Fatalf("end: %+v", v)
		}
	}
	if v := must[VM](t)(f.Get(ctx, "fits")); v.Phase != Requested {
		t.Fatal(v.Phase)
	}
	must[VM](t)(f.End(ctx, "too-big", EndRequest{Code: StartFailed, At: f.now}))
	if err := l.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	if v := must[VM](t)(f.Get(ctx, "fits")); v.Phase != Booting || events[len(events)-1] != "vm_placed" {
		t.Fatalf("placement: %+v, events %v", v, events)
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
	v := must[VM](t)(f.End(ctx, job.ID, EndRequest{At: f.now, Code: Stopped}))
	// The timeout stop bills to the deadline it enforced, not to when the sweep ran.
	jobDeadline := epoch.Add(5*time.Minute+2*time.Second).UnixMilli() + 1000 + JobDeadlineGrace.Milliseconds()
	if jobDeadline >= cutoff {
		t.Fatalf("test setup: deadline %d not before the sweep %d", jobDeadline, cutoff)
	}
	if v.Code != Timeout || v.StopRequestedAt == nil || *v.StopRequestedAt != jobDeadline {
		t.Fatalf("timeout: %+v", v)
	}
	f.assertOutcome(v, jobDeadline)
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
	if reply := must[Reconcile](t)(reconcile(c, Listed{ID: id}, Listed{ID: "unknown"})); !slices.Equal(reply.Stop, []string{id, "unknown"}) {
		t.Fatal(reply)
	}
	must[Reconcile](t)(reconcile(c))
	v := must[VM](t)(f.Get(ctx, id))
	if v.Code != HostLost {
		t.Fatalf("missing VM: %+v", v)
	}
	// Heartbeat free was reported as zero before the end returned the slot.
	f.assertOutcome(v, listed)
	if reply := must[Reconcile](t)(reconcile(c, Listed{ID: id, Finished: true})); !slices.Equal(reply.Stop, []string{id}) {
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
		end := func() { must[VM](t)(f.End(ctx, id, EndRequest{At: f.now, Code: Exit})) }
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
	if !slices.Equal(reply.Stop, []string{"stuck"}) {
		t.Fatalf("a late boot is stopped: %+v", reply)
	}
}
