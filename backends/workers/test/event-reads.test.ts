import assert from "node:assert/strict";
import test from "node:test";
import { eventRead, SUBSCRIBER_SETUP_MS } from "../src/event-reads.ts";

function fixture(acquire?: () => Promise<void>) {
  const tenant = crypto.randomUUID(), slots = new Set<string>();
  let releases = 0;
  const admission = {
    async acquireWatcher(_agent: string, slot: string, limit: number) {
      if (slots.size >= limit) return false;
      slots.add(slot);
      await acquire?.();
      return true;
    },
    async releaseWatcher(slot: string) { slots.delete(slot); releases++; },
  };
  const env = {
    HYPERDRIVE: { connectionString: "subscriber-test" },
    AGENT_TENANTS_JSON: JSON.stringify({ tenants: { [tenant]: { tokenSha256: "0".repeat(64), maxWatchers: 1 } } }),
    TENANTS: { getByName: () => admission },
  } as unknown as Parameters<typeof eventRead>[1];
  const read = (forward: (request: Request) => Promise<Response>) => eventRead(
    new Request("https://fixture/events?watch=1&poll=1"), env, tenant, tenant, forward, () => {},
  );
  return { read, slots, releases: () => releases };
}

test("stuck subscriber setup expires and releases its slots before the upstream completes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const f = fixture();
  let started!: () => void, finish!: (response: Response) => void, forwarded!: Request;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const upstream = new Promise<Response>(resolve => { finish = resolve; });
  const pending = f.read(request => { forwarded = request; started(); return upstream; });
  const expired = assert.rejects(pending, (error: any) => error.status === 504);
  await entered;
  assert.equal(f.slots.size, 1);
  t.mock.timers.tick(SUBSCRIBER_SETUP_MS - 1);
  await assert.rejects(f.read(async () => Response.json({ events: [] })), (error: any) => error.status === 429);
  t.mock.timers.tick(1);
  await expired;
  assert.equal(forwarded.signal.aborted, true);
  assert.equal(f.slots.size, 0);
  assert.equal(f.releases(), 1);
  assert.equal((await f.read(async () => Response.json({ events: [] }))).status, 200);
  let cancelled = false;
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(cancelled, true, "a late upstream response cannot retain a subscriber");
  assert.equal(f.slots.size, 0);
});

test("a stalled subscriber response body also expires but a bounded poll can finish", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const f = fixture();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const body = new ReadableStream();
  const pending = f.read(async () => { started(); return new Response(body); });
  const expired = assert.rejects(pending, (error: any) => error.status === 504);
  await entered;
  while (!body.locked) await Promise.resolve();
  t.mock.timers.tick(SUBSCRIBER_SETUP_MS);
  await expired;
  assert.equal(f.slots.size, 0);
  let startedPoll!: () => void;
  const polling = new Promise<void>(resolve => { startedPoll = resolve; });
  const completed = f.read(async () => {
    const result = new Promise<Response>(resolve => setTimeout(() => resolve(Response.json({ events: [] })), 25_000));
    startedPoll(); return result;
  });
  await polling;
  t.mock.timers.tick(25_000);
  assert.equal((await completed).status, 200);
  assert.equal(f.slots.size, 0);
  t.mock.timers.tick(SUBSCRIBER_SETUP_MS);
  assert.equal(f.releases(), 2, "completed setup clears its expiry timer");
});

test("slow admission cannot extend subscriber setup beyond its durable lease", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let acquired!: () => void;
  const entering = new Promise<void>(resolve => { acquired = resolve; });
  const f = fixture(async () => {
    acquired();
    await new Promise(resolve => setTimeout(resolve, 25_000));
  });
  let forwarded!: Request, started!: () => void;
  const forwarding = new Promise<void>(resolve => { started = resolve; });
  const pending = f.read(request => { forwarded = request; started(); return new Promise(() => {}); });
  const expired = assert.rejects(pending, (error: any) => error.status === 504);
  await entering;
  t.mock.timers.tick(25_000);
  await forwarding;
  assert.equal(f.slots.size, 1);
  t.mock.timers.tick(5_000);
  await expired;
  assert.equal(forwarded.signal.aborted, true);
  assert.equal(f.slots.size, 0);
});
