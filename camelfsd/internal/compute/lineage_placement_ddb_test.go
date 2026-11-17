package compute

import (
	"errors"
	"testing"
)

func TestDDBLineagePlacement(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	pool := "build"
	for _, host := range []string{"host-a", "host-b", "host-c"} {
		info := HostInfo{Pool: pool, Host: host, Slots: 1, Shape: f.request("x", pool).Shape, BootID: "boot"}
		if host != "host-c" {
			info.Images = []string{"guest"}
		}
		must[int64](t)(f.Register(ctx, info))
	}
	// This lineage hashes to host-c, then host-b. Keeping the guest image
	// priority should prefer host-b while either prepared host has room.
	const preferred = "host-b"
	c := f.fresh()
	create := func(id string) VM {
		t.Helper()
		req := f.request(id, pool)
		req.Lineage, req.Image = "lineage-7", "guest"
		return must[VM](t)(c.Create(ctx, req))
	}
	check := func(v VM, host string) {
		t.Helper()
		if v.Host != host || v.Phase != Placed {
			t.Fatalf("%s placed on %s (%s), want %s", v.ID, v.Host, v.Phase, host)
		}
	}
	place := func(id, host string) {
		t.Helper()
		v := create(id)
		check(must[VM](t)(c.Place(ctx, v.ID)), host)
	}
	place("initial", preferred)
	place("preferred-is-full", "host-a")
	must[VM](t)(c.End(ctx, "initial", EndRequest{At: f.now, Code: Stopped}))
	place("preferred-has-room", preferred)
	must[VM](t)(c.End(ctx, "preferred-has-room", EndRequest{At: f.now, Code: Stopped}))

	snapshot := must[[]Host](t)(c.Hosts(ctx, pool))
	must[item](t)(c.update(ctx, change(c.Tables.Hosts, hostKey(pool, preferred), "#bootEpoch = :epoch",
		"SET #draining = :true", attrs{":epoch": n(1), ":true": b(true)})))
	v := create("drain-race")
	check(must[VM](t)(c.placeOnHosts(ctx, v, f.now.UnixMilli(), snapshot)), "host-c")
	v = create("none-eligible")
	if _, err := c.Place(ctx, v.ID); !errors.Is(err, ErrNoHost) {
		t.Fatalf("expected no host, got %v", err)
	}
	for _, h := range must[[]Host](t)(c.Hosts(ctx, pool)) {
		f.checkMemory(h)
		if h.Free != h.Slots-len(h.VMs) {
			t.Fatalf("host %s has inconsistent reservations: %+v", h.Host, h)
		}
	}
}
