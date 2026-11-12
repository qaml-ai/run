import test from "node:test";
import assert from "node:assert/strict";
import { ALARM_HOT_LOOP, guardAlarms } from "../src/alarm-guard.ts";

function object(rearm: (now: number) => number | null) {
  let now = 1_000_000, alarm: number | null = null;
  const logged: any[] = [], error = console.error;
  const ctx = { id: { toString: () => "obj-1" }, storage: { getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; } } };
  const host = { fires: 0, async alarm() { this.fires++; alarm = rearm(now); } };
  return {
    host, ctx, logged, get alarm() { return alarm; }, tick(ms: number) { now += ms; }, now: () => now,
    async capture<T>(run: () => Promise<T>) { console.error = (line: string) => logged.push(JSON.parse(line)); try { return await run(); } finally { console.error = error; } },
  };
}

test("an alarm that keeps re-arming itself for at once is floored at a second from now past the limit, and said once a window", async () => {
  const o = object(now => now + 1);
  guardAlarms(o.host, o.ctx, "Spinner", { now: o.now });
  await o.capture(async () => { for (let i = 0; i < ALARM_HOT_LOOP.fires + 5; i++) { await o.host.alarm(); o.tick(10); } });
  assert.equal(o.host.fires, ALARM_HOT_LOOP.fires + 5, "the handler still runs every time");
  assert.ok(o.alarm! >= o.now() - 10 + ALARM_HOT_LOOP.floorMs, `floored: ${o.alarm} at ${o.now()}`);
  const hot = o.logged.filter(line => line.type === "alarm_hot_loop");
  assert.equal(hot.length, 1, "once per window");
  assert.equal(hot[0].object, "Spinner");
  assert.equal(hot[0].floored, true);
});

test("an alarm that fires now and then, or re-arms for later, is left alone; a test mode run says when it re-arms for at once", async () => {
  const calm = object(now => now + 60_000);
  guardAlarms(calm.host, calm.ctx, "Calm", { now: calm.now });
  await calm.capture(async () => { for (let i = 0; i < 50; i++) { await calm.host.alarm(); calm.tick(1_000); } });
  assert.deepEqual(calm.logged, [], "ten in any 10 s, each re-armed a minute out: no loop");
  const due = object(now => now);
  guardAlarms(due.host, due.ctx, "Due", { now: due.now, test: true });
  await due.capture(() => due.host.alarm());
  assert.deepEqual(due.logged.map(line => line.type), ["alarm_rearm_due"]);
  const none = { other: 1 } as never;
  guardAlarms(none, due.ctx, "NoAlarm");
  assert.equal((none as { alarm?: unknown }).alarm, undefined, "an object without an alarm is left as it is");
});

test("the test-side watch fails a harness whose alarm leaves itself due, or fires past the limit with nothing else happening", async () => {
  const { AlarmWatch } = await import("./alarm-watch.ts");
  const due = new AlarmWatch("Due");
  await assert.rejects(due.fire(5_000, async () => { due.armed(5_000); }), /left itself armed for 5000, at or before now/);
  const spin = new AlarmWatch("Spin");
  let clock = 0;
  await assert.rejects(async () => { for (;;) { clock += 100; await spin.fire(clock, async () => { spin.armed(clock + 100); }); } }, /alarm hot loop/);
  const fed = new AlarmWatch("Fed");
  for (let i = 0; i < 100; i++) { fed.external(); await fed.fire(i * 100, async () => { fed.armed(i * 100 + 100); }); }
});
