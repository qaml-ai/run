package compute

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb/ddbtest"
	"github.com/qaml-ai/run/camelfsd/internal/delivery"
)

var epoch = time.Unix(1_800_000_000, 0)
var lostResponse = errors.New("write committed before crash")

type fixture struct {
	Controller
	t   *testing.T
	now time.Time
}

func table(t *testing.T, keys ...string) (*dynamodb.Client, string) {
	t.Helper()
	var schema ddbtest.Schema
	for i, key := range keys {
		kind := types.KeyTypeHash
		if i == 1 {
			kind = types.KeyTypeRange
		}
		schema.Keys = append(schema.Keys, types.KeySchemaElement{AttributeName: aws.String(key), KeyType: kind})
		schema.Attributes = append(schema.Attributes, types.AttributeDefinition{AttributeName: aws.String(key), AttributeType: types.ScalarAttributeTypeS})
	}
	return ddbtest.Table(t, schema)
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	db, vms := table(t, "id")
	_, hosts := table(t, "pool", "host")
	_, deliveries := table(t, "shard", "id")
	_, usage := table(t, "shard", "ulid")
	f := &fixture{Controller: Controller{DB: db, Tables: Tables{vms, hosts, deliveries, usage},
		RuntimeURL: "https://runtime.example/ended"}, t: t, now: epoch}
	f.EnableClockCheck()
	f.Now = func() time.Time { return f.now }
	return f
}

func (f *fixture) fresh() *Controller {
	return &Controller{DB: f.DB, Tables: f.Tables, Now: f.Now, RuntimeURL: f.RuntimeURL}
}

func must[T any](t *testing.T) func(T, error) T {
	t.Helper()
	return func(value T, err error) T {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
}

func (f *fixture) register(pool, boot string, slots int) int64 {
	f.t.Helper()
	return must[int64](f.t)(f.Register(f.t.Context(), HostInfo{Pool: pool, Host: "host", BootID: boot, Slots: slots, Shape: Shape{VCPUs: 4, MemoryMiB: 8192, DiskGiB: 50}}))
}

func (f *fixture) request(id, pool string) CreateRequest {
	return CreateRequest{ID: id, Pool: pool, Lineage: "lineage", Ref: "main", Payer: "payer", Session: &Session{IdleStopS: DefaultIdleStopS}, Shape: Shape{VCPUs: 2, MemoryMiB: 1024, DiskGiB: 25}, Deadline: f.now.Add(4 * time.Minute)}
}

func (f *fixture) checkHost(pool string, free int, ids ...string) {
	f.t.Helper()
	hosts := must[[]Host](f.t)(f.Hosts(f.t.Context(), pool))
	if len(hosts) != 1 {
		f.t.Fatalf("hosts: %+v", hosts)
	}
	slices.Sort(hosts[0].VMs)
	slices.Sort(ids)
	if hosts[0].Free != free || !slices.Equal(hosts[0].VMs, ids) {
		f.t.Fatalf("host free/set = %d/%v, want %d/%v", hosts[0].Free, hosts[0].VMs, free, ids)
	}
	f.checkMemory(hosts[0])
}

func (f *fixture) checkMemory(h Host) {
	f.t.Helper()
	want := h.MemoryMiB
	for _, id := range h.VMs {
		v := must[VM](f.t)(f.Get(f.t.Context(), id))
		want -= v.Shape.MemoryMiB
	}
	if h.MemoryMiB != h.Shape.MemoryMiB || want < 0 || h.FreeMiB != want {
		f.t.Fatalf("host %s memory total/free = %d/%d, want %d/%d", h.Host, h.MemoryMiB, h.FreeMiB, h.Shape.MemoryMiB, want)
	}
}

func (f *fixture) assertOutcome(v VM, through int64) {
	f.t.Helper()
	ctx := f.t.Context()
	id := "vm.ended:" + v.ID
	i := must[item](f.t)(f.read(ctx, f.Tables.Deliveries, attrs{"shard": s(delivery.Shard(id)), "id": s(id)}))
	if i["body"] == nil || v.Phase != Ended {
		f.t.Fatalf("missing outcome: %+v", v)
	}
	f.checkHost(v.Pool, 1)
	if waiting := must[[]Waiter](f.t)(f.Waiting(ctx, v.Pool)); len(waiting) != 0 {
		f.t.Fatal(waiting)
	}
	// Query only this VM's shard, since the fixture retains events from other cases.
	const cond = "#shard = :shard"
	pages := dynamodb.NewQueryPaginator(f.DB, &dynamodb.QueryInput{
		TableName: aws.String(f.Tables.Usage), ConsistentRead: aws.Bool(true),
		KeyConditionExpression: aws.String(cond), ExpressionAttributeNames: aliases(cond),
		ExpressionAttributeValues: attrs{":shard": s(delivery.Shard(v.ID))},
	})
	var events []UsageEvent
	for pages.HasMorePages() {
		page := must[*dynamodb.QueryOutput](f.t)(pages.NextPage(ctx))
		for _, attrs := range page.Items {
			row := item(attrs)
			if row.text("vm") == v.ID {
				var event UsageEvent
				if err := json.Unmarshal([]byte(row.text("body")), &event); err != nil {
					f.t.Fatal(err)
				}
				if row.text("eventId") != event.ID || row.number("expiresAt") < epoch.Add(35*24*time.Hour).Unix() {
					f.t.Fatalf("bad usage item: %+v", row)
				}
				events = append(events, event)
			}
		}
	}
	if v.StartedAt == nil {
		if len(events) != 0 {
			f.t.Fatal(events)
		}
		return
	}
	slices.SortFunc(events, func(a, b UsageEvent) int {
		if a.Final != b.Final {
			if a.Final {
				return 1
			}
			return -1
		}
		return strings.Compare(a.ID, b.ID)
	})
	if len(events) != int(v.UsageSeq) || len(events) == 0 {
		f.t.Fatalf("usage count: %d != %d", len(events), v.UsageSeq)
	}
	from := *v.StartedAt
	var ms int64
	for seq, e := range events {
		if e.ID != v.ID+":"+strconv.Itoa(seq) || e.From != from || e.To < e.From ||
			e.Final != (seq == len(events)-1) || e.Payer != v.Payer || e.Host != v.Host {
			f.t.Fatalf("usage discontinuity at %d: %+v (want from=%d)", seq, e, from)
		}
		from = e.To
		ms += int64(math.Round(e.Seconds * 1000))
	}
	if from != through || ms != through-*v.StartedAt {
		f.t.Fatalf("usage %d ms through %d, want %d ms through %d", ms, from, through-*v.StartedAt, through)
	}
}

type step struct {
	offset time.Duration
	call   func(*Controller) (VM, error)
}

func (f *fixture) startSteps(req CreateRequest) []step {
	ctx := f.t.Context()
	id := req.ID
	return []step{
		{0, func(c *Controller) (VM, error) { return c.Create(ctx, req) }},
		{0, func(c *Controller) (VM, error) { return c.Place(ctx, id) }},
		{time.Second, func(c *Controller) (VM, error) { return c.MarkBooting(ctx, id) }},
		{2 * time.Second, func(c *Controller) (VM, error) { return c.Started(ctx, id, "host", 1, f.now) }},
	}
}

func TestDDBReplayAndCrashEveryWrite(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	// One case without an injected crash, then one for each successful write.
	for crashAt := 0; crashAt <= 13; crashAt++ {
		t.Run(fmt.Sprint(crashAt), func(t *testing.T) {
			f.t, f.now = t, epoch
			id := fmt.Sprint("vm-", crashAt)
			f.register(id, "boot", 1)
			req := f.request(id, id)
			req.Deadline = epoch.Add(time.Minute)
			steps := append(f.startSteps(req), step{3 * time.Second, func(c *Controller) (VM, error) {
				return c.ExtendDeadline(ctx, id, epoch.Add(4*time.Minute))
			}})
			for _, seconds := range []int{63, 123, 183} {
				steps = append(steps, step{time.Duration(seconds) * time.Second, func(c *Controller) (VM, error) {
					return c.Listed(ctx, id, "host", 1, f.now)
				}})
			}
			if crashAt == 0 {
				steps = append(steps, step{190 * time.Second, func(c *Controller) (VM, error) {
					return c.End(ctx, id, EndRequest{Code: Stopped, At: f.now})
				}})
			} else {
				steps = append(steps,
					step{240 * time.Second, func(c *Controller) (VM, error) { return c.ExpireLease(ctx, id) }},
					step{241 * time.Second, func(c *Controller) (VM, error) {
						return c.End(ctx, id, EndRequest{Code: Stopped, At: f.now})
					}})
			}
			count, crashed := 0, false
			c := f.fresh()
			c.afterWrite = func() error {
				count++
				if count == crashAt {
					return lostResponse
				}
				return nil
			}
			for index, step := range steps {
				f.now = epoch.Add(step.offset)
				v, err := step.call(c)
				if errors.Is(err, lostResponse) {
					crashed = true
					// Recover with a fresh controller and replay all calls made so far.
					c = f.fresh()
					current := f.now
					for _, previous := range steps[:index+1] {
						f.now = epoch.Add(previous.offset)
						v = must[VM](t)(previous.call(c))
					}
					f.now = current
				} else if err != nil {
					t.Fatal(err)
				}
				replay := must[VM](t)(step.call(c))
				if !reflect.DeepEqual(v, replay) {
					t.Fatalf("step %d replay differs: %+v / %+v", index, v, replay)
				}
				if index == 0 && len(must[[]Waiter](t)(c.Waiting(ctx, id))) != 1 {
					t.Fatal("Create did not persist one waiter")
				}
				if index == 1 {
					f.checkHost(id, 0, id)
				}
			}
			if crashAt != 0 && !crashed {
				t.Fatal("did not inject crash")
			}
			v := must[VM](t)(c.Get(ctx, id))
			through := epoch.Add(190 * time.Second).UnixMilli()
			if crashAt != 0 {
				through = epoch.Add(4 * time.Minute).UnixMilli()
				if v.Code != LeaseExpired || !v.StopCheckpoint {
					t.Fatalf("lease stop: %+v", v)
				}
			}
			f.assertOutcome(v, through)
		})
	}
}

func TestDDBPlacementConcurrency(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.register("many", "boot", 4)
	f.register("same", "boot", 3)
	for i := range 8 {
		req := f.request(fmt.Sprint(i), "many")
		req.Shape.MemoryMiB = 3072 + i%2*1024
		must[VM](t)(f.Create(ctx, req))
	}
	must[VM](t)(f.Create(ctx, f.request("same", "same")))
	for _, same := range []bool{false, true} {
		var wg sync.WaitGroup
		errs := make(chan error, 8)
		for i := range 8 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				id := fmt.Sprint(i)
				if same {
					id = "same"
				}
				_, err := f.fresh().Place(ctx, id)
				errs <- err
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil && !errors.Is(err, ErrCondition) && !errors.Is(err, ErrNoHost) {
				t.Fatal(err)
			}
		}
		if same {
			f.checkHost("same", 2, "same")
			continue
		}
		var placed []string
		for i := range 8 {
			v := must[VM](t)(f.Get(ctx, fmt.Sprint(i)))
			if v.Phase == Placed {
				placed = append(placed, v.ID)
			}
		}
		if len(placed) != 2 {
			t.Fatalf("placed: %v", placed)
		}
		f.checkHost("many", 2, placed...)
	}
}

func TestDDBStopAndWaiters(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	for phaseIndex, phase := range []Phase{Requested, Placed, Booting, Running} {
		for _, expire := range []bool{false, true} {
			id := fmt.Sprintf("%s-%t", phase, expire)
			f.now = epoch
			f.register(id, "boot", 1)
			req := f.request(id, id)
			req.Deadline = epoch.Add(90 * time.Second)
			for _, step := range f.startSteps(req)[:phaseIndex+1] {
				f.now = epoch.Add(step.offset)
				must[VM](t)(step.call(f.fresh()))
			}
			f.now = epoch.Add(100*time.Second + 567*time.Millisecond)
			var v VM
			cutoff, code := f.now.UnixMilli(), Stopped
			if expire {
				v = must[VM](t)(f.fresh().ExpireLease(ctx, id))
				cutoff, code = req.Deadline.UnixMilli(), LeaseExpired
			} else {
				v = must[VM](t)(f.fresh().RequestStop(ctx, id, true))
			}
			if v.StopRequestedAt == nil || *v.StopRequestedAt != cutoff || !v.StopCheckpoint {
				t.Fatalf("stop intent: %+v", v)
			}
			if phase == Requested || phase == Placed {
				if v.Phase != Ended {
					t.Fatalf("immediate stop: %+v", v)
				}
			} else {
				if v.Phase != Stopping {
					t.Fatalf("durable stop: %+v", v)
				}
				f.now = f.now.Add(time.Second)
				v = must[VM](t)(f.fresh().End(ctx, id, EndRequest{At: f.now, Code: Stopped}))
			}
			if v.Code != code {
				t.Fatalf("end code: %+v", v)
			}
			f.assertOutcome(v, min(cutoff, req.Deadline.UnixMilli()))
			if got := must[VM](t)(f.ExtendDeadline(ctx, id, f.now.Add(time.Hour))); got.LeaseDeadline != v.LeaseDeadline {
				t.Fatalf("extended ended VM: %+v", got)
			}
		}
	}
	f.now = epoch
	f.register("wait", "boot", 1)
	first := f.request("z-first", "wait")
	must[VM](t)(f.Create(ctx, first))
	f.now = f.now.Add(time.Millisecond)
	must[VM](t)(f.Create(ctx, f.request("a-second", "wait")))
	wait := must[[]Waiter](t)(f.Waiting(ctx, "wait"))
	if len(wait) != 2 || wait[0].VM != "z-first" || wait[1].VM != "a-second" {
		t.Fatal(wait)
	}
	f.now = f.now.Add(time.Second)
	if v := must[VM](t)(f.ExpireWaiting(ctx, first.ID, 100)); v.Phase != Ended || v.Code != StartFailed {
		t.Fatalf("expired waiter: %+v", v)
	}
	wait = must[[]Waiter](t)(f.Waiting(ctx, "wait"))
	if len(wait) != 1 || wait[0].VM != "a-second" {
		t.Fatal(wait)
	}
	f.checkHost("wait", 1)
}

func TestDDBHostRestartAndLost(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	for crashAt := 0; crashAt <= 3; crashAt++ {
		id := fmt.Sprint("host-loss-", crashAt)
		f.now = epoch
		f.register(id, "old", 1)
		for _, step := range f.startSteps(f.request(id, id)) {
			f.now = epoch.Add(step.offset)
			must[VM](t)(step.call(f.fresh()))
		}
		f.now = epoch.Add(7*time.Second + time.Millisecond)
		must[VM](t)(f.Listed(ctx, id, "host", 1, f.now))
		lastListed := f.now.UnixMilli()
		f.now = epoch.Add(8 * time.Second)
		if err := f.Heartbeat(ctx, id, "host", 1, 1, f.now); err != nil {
			t.Fatal(err)
		}
		f.checkHost(id, 0, id)
		f.now = epoch.Add(time.Minute)
		if crashAt == 0 {
			must[VM](t)(f.End(ctx, id, EndRequest{Code: HostLost, At: f.now}))
		} else {
			h := HostInfo{Pool: id, Host: "host", BootID: "new", Slots: 1, Shape: Shape{VCPUs: 4, MemoryMiB: 8192, DiskGiB: 50}}
			c := f.fresh()
			count := 0
			c.afterWrite = func() error {
				count++
				if count == crashAt {
					return lostResponse
				}
				return nil
			}
			if _, err := c.Register(ctx, h); !errors.Is(err, lostResponse) {
				t.Fatalf("restart crash %d: %v", crashAt, err)
			}
			if got := must[int64](t)(f.fresh().Register(ctx, h)); got != 2 {
				t.Fatalf("epoch: %d", got)
			}
		}
		v := must[VM](t)(f.Get(ctx, id))
		if v.Code != HostLost || v.EndedAt == nil || *v.EndedAt != lastListed {
			t.Fatalf("host loss: %+v", v)
		}
		f.assertOutcome(v, lastListed)
	}
}

func TestDDBUsagePagination(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	// Seed every shard, with many entries sharing the same timestamp.
	watermark := epoch.Add(20 * time.Second)
	for i := range 112 {
		f.now = watermark.Add(-time.Millisecond)
		if i%7 == 0 {
			f.now = watermark
		}
		id := fmt.Sprint("page-", i)
		event := &UsageEvent{ID: id + ":0", VM: id, Type: "usage.vm"}
		if err := f.writeWithUsage(ctx, event, 0); err != nil {
			t.Fatal(err)
		}
	}
	var cursor string
	seen := map[string]bool{}
	for {
		events, next, err := f.ListUsage(ctx, cursor, 3, watermark)
		if err != nil {
			t.Fatal(err)
		}
		repeat, same, err := f.ListUsage(ctx, cursor, 3, watermark)
		if err != nil || !reflect.DeepEqual(events, repeat) || next != same {
			t.Fatal("pagination replay changed", err)
		}
		if len(events) == 0 {
			if next != cursor {
				t.Fatal("cursor advanced with no events")
			}
			break
		}
		for _, raw := range events {
			var event UsageEvent
			if err := json.Unmarshal(raw, &event); err != nil {
				t.Fatal(err)
			}
			if seen[event.ID] {
				t.Fatalf("duplicate: %s", event.ID)
			}
			seen[event.ID] = true
		}
		cursor = next
	}
	for i := range 112 {
		if id := fmt.Sprintf("page-%d:0", i); seen[id] != (i%7 != 0) {
			t.Fatalf("unexpected watermark membership: %s", id)
		}
	}
	late, _, err := f.ListUsage(ctx, cursor, 112, watermark.Add(time.Millisecond))
	if err != nil || len(late) != 16 {
		t.Fatalf("later watermark: %d events (%v)", len(late), err)
	}
	for _, raw := range late {
		var event UsageEvent
		if err := json.Unmarshal(raw, &event); err != nil {
			t.Fatal(err)
		}
		if seen[event.ID] {
			t.Fatalf("cursor re-read %s", event.ID)
		}
	}
}

func TestDDBRandomCrashes(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	rng := rand.New(rand.NewSource(14))
	for run := range 500 {
		id := fmt.Sprintf("random-%03d", run)
		f.now = epoch
		f.register(id, "boot", 1)
		req := f.request(id, id)
		req.Deadline = epoch.Add(time.Duration(75+rng.Intn(150)) * time.Second)
		for _, step := range f.startSteps(req) {
			f.now = epoch.Add(step.offset)
			must[VM](t)(step.call(f.fresh()))
		}
		deadline := req.Deadline
		for range 12 {
			f.now = f.now.Add(time.Duration(5+rng.Intn(45))*time.Second + time.Millisecond)
			until := deadline.Add(time.Duration(rng.Intn(80)-30) * time.Second)
			calls := []func(*Controller) (VM, error){
				func(c *Controller) (VM, error) { return c.Listed(ctx, id, "host", 1, f.now) },
				func(c *Controller) (VM, error) { return c.ExtendUsage(ctx, id, f.now) },
				func(c *Controller) (VM, error) { return c.RequestStop(ctx, id, true) },
				func(c *Controller) (VM, error) { return c.ExtendDeadline(ctx, id, until) },
				func(c *Controller) (VM, error) { return c.ExpireLease(ctx, id) },
				func(c *Controller) (VM, error) { return c.End(ctx, id, EndRequest{Code: Stopped, At: f.now}) },
			}
			selected := rng.Intn(len(calls))
			c := f.fresh()
			if rng.Intn(2) == 0 {
				c.afterWrite = func() error { return lostResponse }
			}
			v, err := calls[selected](c)
			if errors.Is(err, lostResponse) {
				v, err = calls[selected](f.fresh())
			}
			// A renewal after the deadline is refused: a lapsed lease is final.
			if errors.Is(err, ErrLeaseExpired) && selected == 3 {
				v = must[VM](t)(f.fresh().Get(ctx, id))
				if f.now.UnixMilli() < v.LeaseDeadline {
					t.Fatalf("refused a renewal of a live lease: %+v", v)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			deadline = v.Deadline
		}
		c := f.fresh()
		v := must[VM](t)(c.End(ctx, id, EndRequest{Code: Stopped, At: f.now}))
		cutoff := min(*v.EndedAt, v.LeaseDeadline)
		if v.StopRequestedAt != nil {
			cutoff = min(cutoff, *v.StopRequestedAt)
		}
		f.assertOutcome(v, cutoff)
	}
}

func TestDDBLapsedLeaseIsFinalAndEndsClampToNow(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	run := func(id string, deadline time.Duration) CreateRequest {
		f.now = epoch
		f.register(id, "boot", 1)
		req := f.request(id, id)
		req.Deadline = epoch.Add(deadline)
		for _, step := range f.startSteps(req) {
			f.now = epoch.Add(step.offset)
			must[VM](t)(step.call(f.fresh()))
		}
		return req
	}

	// A renewal after the deadline never revives the lease, even before the sweep stopped the VM.
	lapsed := run("lapsed", 90*time.Second)
	f.now = lapsed.Deadline.Add(time.Second)
	if _, err := f.fresh().ExtendDeadline(ctx, lapsed.ID, f.now.Add(time.Hour)); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("lapsed renewal: %v", err)
	}
	v := must[VM](t)(f.fresh().ExpireLease(ctx, lapsed.ID))
	v = must[VM](t)(f.fresh().End(ctx, lapsed.ID, EndRequest{At: f.now.Add(time.Minute), Code: Stopped}))
	if v.Code != LeaseExpired {
		t.Fatalf("lapsed end: %+v", v)
	}
	f.assertOutcome(v, lapsed.Deadline.UnixMilli())

	// A host-reported end (or heartbeat) in the future is billed to the tier's clock, never beyond it.
	future := run("future", time.Hour)
	f.now = epoch.Add(3 * time.Minute)
	must[VM](t)(f.fresh().ExtendUsage(ctx, future.ID, f.now.Add(time.Hour)))
	v = must[VM](t)(f.fresh().End(ctx, future.ID, EndRequest{At: f.now.Add(time.Hour), Code: Stopped}))
	f.assertOutcome(v, f.now.UnixMilli())
}
