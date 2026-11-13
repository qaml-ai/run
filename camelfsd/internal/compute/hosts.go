package compute

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

const hostFreshMS = int64(30_000)
const waitPrefix = "~wait#"

func rank(hosts []Host, shape Shape, now int64) []Host {
	var candidates []Host
	for _, h := range hosts {
		if h.Free > 0 && !h.Draining && h.LastSeenAt > now-hostFreshMS &&
			h.Shape.VCPUs >= shape.VCPUs && h.Shape.MemoryMiB >= shape.MemoryMiB && h.Shape.DiskGiB >= shape.DiskGiB {
			candidates = append(candidates, h)
		}
	}
	slices.SortFunc(candidates, func(a, b Host) int {
		if a.Free != b.Free {
			return b.Free - a.Free
		}
		return strings.Compare(a.Host, b.Host)
	})
	return candidates
}

func readHost(i item) Host {
	return Host{
		HostInfo: HostInfo{Pool: i.text("pool"), Host: i.text("host"), BootID: i.text("bootID"),
			Addr: i.text("addr"), Shape: readShape(i.object("shape")), Slots: int(i.number("slots")),
			Features: i.set("features"), Draining: i.flag("draining")},
		BootEpoch: i.number("bootEpoch"), LastSeenAt: i.number("lastSeenAt"), Free: int(i.number("free")),
		VMs: i.set("vms"), Restarting: i.flag("restarting"),
	}
}

func hostItem(h HostInfo, epoch, now int64) attrs {
	i := hostKey(h.Pool, h.Host)
	i["bootID"], i["bootEpoch"], i["shape"] = s(h.BootID), n(epoch), shapeItem(h.Shape)
	i["slots"], i["free"] = n(int64(h.Slots)), n(int64(h.Slots))
	i["lastSeenAt"], i["draining"], i["addr"] = n(now), b(h.Draining), s(h.Addr)
	if len(h.Features) > 0 {
		i["features"] = ss(h.Features...)
	}
	return i
}

func (c *Controller) Register(ctx context.Context, h HostInfo) (int64, error) {
	if h.Pool == "" || h.Host == "" || h.BootID == "" || h.Slots < 0 || strings.HasPrefix(h.Host, waitPrefix) {
		return 0, ErrInvalid
	}
	key := hostKey(h.Pool, h.Host)
	i, err := c.read(ctx, c.Tables.Hosts, key)
	now := c.now().UnixMilli()
	if err == ErrNotFound {
		return 1, c.transact(ctx, put(c.Tables.Hosts, hostItem(h, 1, now), "attribute_not_exists(#host)"))
	}
	if err != nil {
		return 0, err
	}
	current := readHost(i)
	if current.BootID == h.BootID && !current.Restarting {
		return current.BootEpoch, nil
	}
	epoch := current.BootEpoch
	if current.BootID != h.BootID {
		// Fence the previous boot before reading its authoritative reservation set.
		// Keep the set on the host row so a fresh controller can finish the restart.
		epoch++
		i, err = c.update(ctx, change(c.Tables.Hosts, key, "#bootEpoch = :previous",
			"SET #bootEpoch = :epoch, #bootID = :boot, #draining = :true, #restarting = :true",
			attrs{":previous": n(current.BootEpoch), ":epoch": n(epoch), ":boot": s(h.BootID), ":true": b(true)}))
		if err != nil {
			return 0, err
		}
		current = readHost(i)
	}
	for _, id := range current.VMs {
		if _, err := c.End(ctx, id, EndRequest{Code: HostLost}); err != nil {
			return 0, err
		}
	}
	replacement := put(c.Tables.Hosts, hostItem(h, epoch, c.now().UnixMilli()),
		"#bootEpoch = :epoch AND #restarting = :true AND attribute_not_exists(#vms)")
	replacement.Put.ExpressionAttributeValues = attrs{":epoch": n(epoch), ":true": b(true)}
	return epoch, c.transact(ctx, replacement)
}

func (c *Controller) Heartbeat(ctx context.Context, pool, host string, bootEpoch int64, free int, at time.Time) error {
	key := hostKey(pool, host)
	i, err := c.read(ctx, c.Tables.Hosts, key)
	if err != nil {
		return err
	}
	h := readHost(i)
	if h.BootEpoch != bootEpoch || h.Restarting {
		return ErrHost
	}
	if at.UnixMilli() <= h.LastSeenAt {
		return nil
	}
	// The report can predate a placement. The durable reservations bound
	// capacity even when the host has yet to receive those placements.
	free = max(0, min(free, h.Slots-len(h.VMs)))
	cond := "#bootEpoch = :epoch AND attribute_not_exists(#restarting) AND #lastSeenAt < :at"
	values := attrs{":epoch": n(bootEpoch), ":at": n(at.UnixMilli()), ":free": n(int64(free))}
	if len(h.VMs) == 0 {
		cond += " AND attribute_not_exists(#vms)"
	} else {
		cond += " AND size(#vms) = :count"
		values[":count"] = n(int64(len(h.VMs)))
	}
	_, err = c.update(ctx, change(c.Tables.Hosts, key, cond, "SET #lastSeenAt = :at, #free = :free", values))
	return err
}

func (c *Controller) poolItems(ctx context.Context, pool string, waiting bool) ([]item, error) {
	cond := "#pool = :pool"
	values := attrs{":pool": s(pool)}
	if waiting {
		cond = "#pool = :pool AND begins_with(#host, :wait)"
		values[":wait"] = s(waitPrefix)
	}
	pages := dynamodb.NewQueryPaginator(c.DB, &dynamodb.QueryInput{
		TableName: aws.String(c.Tables.Hosts), ConsistentRead: aws.Bool(true),
		KeyConditionExpression: aws.String(cond), ExpressionAttributeNames: aliases(cond),
		ExpressionAttributeValues: values,
	})
	var result []item
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, i := range page.Items {
			result = append(result, i)
		}
	}
	return result, nil
}

func (c *Controller) Hosts(ctx context.Context, pool string) ([]Host, error) {
	items, err := c.poolItems(ctx, pool, false)
	if err != nil {
		return nil, err
	}
	hosts := make([]Host, 0, len(items))
	for _, i := range items {
		if i.text("kind") != "wait" {
			hosts = append(hosts, readHost(i))
		}
	}
	return hosts, nil
}

func (c *Controller) Waiting(ctx context.Context, pool string) ([]Waiter, error) {
	items, err := c.poolItems(ctx, pool, true)
	if err != nil {
		return nil, err
	}
	waiters := make([]Waiter, 0, len(items))
	for _, i := range items {
		waiters = append(waiters, Waiter{Pool: i.text("pool"), Host: i.text("host"), VM: i.text("vm"), CreatedAt: i.number("createdAt"),
			MemoryMiB: int(i.number("memoryMiB")), VCPUs: int(i.number("vcpus"))})
	}
	return waiters, nil
}
