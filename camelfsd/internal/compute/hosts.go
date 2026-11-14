package compute

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

const hostFreshMS = int64(30_000)
const waitPrefix = "~wait#"

func rank(hosts []Host, shape Shape, now int64) []Host {
	return rankImage(hosts, shape, now-hostFreshMS, "")
}

func (shape Shape) diskMiB() int {
	if shape.DiskMiB != 0 {
		return shape.DiskMiB
	}
	return shape.DiskGiB * 1024
}

func (c *Controller) hostCutoff(now int64) int64 {
	if c.HostFresh > 0 {
		return now - c.HostFresh.Milliseconds()
	}
	return now - hostFreshMS
}

func rankImage(hosts []Host, shape Shape, cutoff int64, image string) []Host {
	var candidates []Host
	for _, h := range hosts {
		if h.Free > 0 && !h.Draining && h.LastSeenAt > cutoff &&
			h.Shape.VCPUs >= shape.VCPUs && h.FreeMiB >= shape.MemoryMiB && h.Shape.diskMiB() >= shape.diskMiB() {
			candidates = append(candidates, h)
		}
	}
	slices.SortFunc(candidates, func(a, b Host) int {
		aWarm, bWarm := image != "" && slices.Contains(a.Images, image), image != "" && slices.Contains(b.Images, image)
		if aWarm != bWarm {
			if aWarm {
				return -1
			}
			return 1
		}
		if a.Free != b.Free {
			return b.Free - a.Free
		}
		if a.FreeMiB != b.FreeMiB {
			return b.FreeMiB - a.FreeMiB
		}
		return strings.Compare(a.Host, b.Host)
	})
	return candidates
}

func readHost(i item) Host {
	return Host{
		HostInfo: HostInfo{Pool: i.text("pool"), Host: i.text("host"), BootID: i.text("bootID"),
			Addr: i.text("addr"), Shape: readShape(i.object("shape")), Slots: int(i.number("slots")),
			Features: i.set("features"), Images: i.set("images"), Draining: i.flag("draining")},
		BootEpoch: i.number("bootEpoch"), LastSeenAt: i.number("lastSeenAt"), Free: int(i.number("free")),
		MemoryMiB: int(i.number("memoryMiB")), FreeMiB: int(i.number("freeMiB")),
		VMs: i.set("vms"), Restarting: i.flag("restarting"), Lost: i.flag("lost"),
	}
}

func hostItem(h HostInfo, epoch, now int64) attrs {
	i := hostKey(h.Pool, h.Host)
	i["bootID"], i["bootEpoch"], i["shape"] = s(h.BootID), n(epoch), shapeItem(h.Shape)
	i["memoryMiB"], i["freeMiB"] = n(int64(h.Shape.MemoryMiB)), n(int64(h.Shape.MemoryMiB))
	i["slots"], i["free"] = n(int64(h.Slots)), n(int64(h.Slots))
	i["lastSeenAt"], i["draining"], i["addr"] = n(now), b(h.Draining), s(h.Addr)
	if len(h.Features) > 0 {
		i["features"] = ss(h.Features...)
	}
	if len(h.Images) > 0 {
		i["images"] = ss(h.Images...)
	}
	return i
}

func (c *Controller) Register(ctx context.Context, h HostInfo) (int64, error) {
	if h.Pool == "" || h.Host == "" || h.BootID == "" || h.Slots < 0 || h.Shape.MemoryMiB < 0 || strings.HasPrefix(h.Host, waitPrefix) {
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
		if !i.flag("lost") {
			replacement := hostItem(h, current.BootEpoch, now)
			expr := "SET #addr = :addr"
			values := attrs{":addr": replacement["addr"], ":epoch": n(current.BootEpoch)}
			if images := replacement["images"]; images != nil {
				expr += ", #images = :images"
				values[":images"] = images
			} else {
				expr += " REMOVE #images"
			}
			_, err := c.update(ctx, change(c.Tables.Hosts, key,
				"#bootEpoch = :epoch AND attribute_not_exists(#restarting) AND attribute_not_exists(#lost)", expr, values))
			return current.BootEpoch, err
		}
		epoch := current.BootEpoch + 1
		replacement := put(c.Tables.Hosts, hostItem(h, epoch, now),
			"#bootEpoch = :epoch AND #lost = :true AND attribute_not_exists(#vms)")
		replacement.Put.ExpressionAttributeValues = attrs{":epoch": n(current.BootEpoch), ":true": b(true)}
		return epoch, c.transact(ctx, replacement)
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
	_, _, err := c.heartbeat(ctx, pool, host, bootEpoch, free, at)
	return err
}

func (c *Controller) heartbeat(ctx context.Context, pool, host string, bootEpoch int64, free int, at time.Time) (Host, time.Time, error) {
	key := hostKey(pool, host)
	i, err := c.read(ctx, c.Tables.Hosts, key)
	if err != nil {
		return Host{}, time.Time{}, err
	}
	h := readHost(i)
	if h.BootEpoch != bootEpoch || h.Restarting || h.Lost {
		return Host{}, time.Time{}, ErrHost
	}
	at = time.UnixMilli(max(h.LastSeenAt, min(at.UnixMilli(), c.now().UnixMilli())))
	if at.UnixMilli() == h.LastSeenAt {
		return h, at, nil
	}
	// The report can predate a placement. The durable reservations bound
	// capacity even when the host has yet to receive those placements.
	free = max(0, min(free, h.Slots-len(h.VMs)))
	cond := "#bootEpoch = :epoch AND attribute_not_exists(#restarting) AND attribute_not_exists(#lost) AND #lastSeenAt < :at"
	values := attrs{":epoch": n(bootEpoch), ":at": n(at.UnixMilli()), ":free": n(int64(free))}
	if len(h.VMs) == 0 {
		cond += " AND attribute_not_exists(#vms)"
	} else {
		cond += " AND size(#vms) = :count"
		values[":count"] = n(int64(len(h.VMs)))
	}
	i, err = c.update(ctx, change(c.Tables.Hosts, key, cond, "SET #lastSeenAt = :at, #free = :free", values))
	if errors.Is(err, ErrCondition) {
		current, readErr := c.read(ctx, c.Tables.Hosts, key)
		if readErr != nil {
			return Host{}, time.Time{}, readErr
		}
		h := readHost(current)
		if h.BootEpoch != bootEpoch || h.Restarting || h.Lost {
			return Host{}, time.Time{}, ErrHost
		}
	}
	if err != nil {
		return Host{}, time.Time{}, err
	}
	return readHost(i), at, nil
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

func (c *Controller) Host(ctx context.Context, pool, host string) (Host, error) {
	i, err := c.read(ctx, c.Tables.Hosts, hostKey(pool, host))
	return readHost(i), err
}

// FindHost checks the exact host key within each configured pool partition.
func (c *Controller) FindHost(ctx context.Context, pools []string, host string) (Host, error) {
	var found Host
	for _, pool := range pools {
		const cond = "#pool = :pool AND #host = :host"
		out, err := c.DB.Query(ctx, &dynamodb.QueryInput{
			TableName: aws.String(c.Tables.Hosts), ConsistentRead: aws.Bool(true),
			KeyConditionExpression: aws.String(cond), ExpressionAttributeNames: aliases(cond),
			ExpressionAttributeValues: attrs{":pool": s(pool), ":host": s(host)},
		})
		if err != nil {
			return Host{}, err
		}
		if len(out.Items) > 0 {
			if found.Host != "" {
				return Host{}, ErrHost
			}
			found = readHost(out.Items[0])
		}
	}
	if found.Host == "" {
		return Host{}, ErrHost
	}
	return found, nil
}

func (c *Controller) Hosts(ctx context.Context, pool string) ([]Host, error) {
	items, err := c.poolItems(ctx, pool, false)
	if err != nil {
		return nil, err
	}
	hosts := make([]Host, 0, len(items))
	for _, i := range items {
		if i.text("kind") == "" {
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
