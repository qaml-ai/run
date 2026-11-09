import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { RequestRecord } from "../src/agent-types.ts";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./control.ts" && context.parentURL?.endsWith("/src/input-admission.ts"))
    return { url: "data:text/javascript,export async function releaseTurn() {}", shortCircuit: true };
  return next(specifier, context);
} });
const { inputAdmissionDeadline, releaseInputPrompts } = await import("../src/input-admission.ts");
const { requestView } = await import("../src/request-view.ts");

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: 1_000_000 }));
afterEach(() => mock.timers.reset());

function fixture() {
  const values = new Map<string, any>(), calls: string[] = [], released: string[] = [], tracked: string[] = [], events: any[] = [], deadlines: number[] = [];
  const read = (key: string) => structuredClone(values.get(key));
  const storage = {
    get: async <T>(key: string): Promise<T | undefined> => read(key),
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    transaction: async (fn: (tx: any) => Promise<unknown>) => fn(storage),
  };
  const records = async () => [...values.entries()].filter(([key]) => key.startsWith("request:")).map(([, value]) => structuredClone(value) as RequestRecord);
  let failure: (id: string) => unknown = () => undefined;
  const runtime = {
    ctx: { storage }, records,
    config: async () => ({ tenantId: "tenant", id: "agent" }),
    env: { TENANTS: { getByName: () => ({ release: async (id: string) => { released.push(id); } }) } },
    track: (id: string) => { tracked.push(id); },
    admit: async ({ id }: { id: string }) => {
      calls.push(id);
      const error = failure(id);
      if (error) throw error;
      const record = read(`request:${id}`);
      delete record.heldForInput;
      delete record.inputAdmissionRetry;
      await storage.put(`request:${id}`, { ...record, accepted: true });
    },
    flushTerminalEvents: async () => {
      for (const [key, value] of values) if (key.startsWith("terminal-events:")) {
        events.push(...value.events);
        values.delete(key);
      }
    },
    arm: async () => { deadlines.push(inputAdmissionDeadline(await records())); },
  };
  function hold(id: string, extra: Partial<RequestRecord> = {}) {
    values.set(`request:${id}`, { id, method: "prompt", params: { text: id }, fingerprint: id, startedAt: Date.now(), state: "queued", heldForInput: true, ...extra });
  }
  return { runtime, hold, read, values, calls, released, tracked, events, deadlines,
    fail: (run: typeof failure) => { failure = run; },
    run: () => releaseInputPrompts(runtime as any),
  };
}

test("lasting held-prompt refusals fail with a normal error response and release later requests", async () => {
  const f = fixture();
  f.hold("credit", { admitted: true }); f.hold("invalid"); f.hold("later");
  f.fail(id => id === "credit" ? Object.assign(new Error("Credit refused"), { status: 402 }) : id === "invalid" ? Object.assign(new Error("Invalid admission"), { status: 400 }) : undefined);
  await f.run();
  assert.deepEqual(f.calls, ["credit", "invalid", "later"]);
  for (const id of ["credit", "invalid"]) {
    const record = f.read(`request:${id}`);
    assert.equal(record.status, "failed"); assert.equal(record.state, "completed");
    assert.equal(record.heldForInput, undefined); assert.equal(record.inputAdmissionRetry, undefined);
    assert.equal(record.endedAt, Date.now());
  }
  assert.deepEqual(f.released, ["agent:credit"]);
  assert.deepEqual(f.events, [{ type: "response", id: "credit", outcome: { error: "Credit refused" } }, { type: "response", id: "invalid", outcome: { error: "Invalid admission" } }]);
  assert.equal(f.read("request:later").accepted, true);
  assert.deepEqual(f.deadlines, [Infinity], "a lasting admission error adds no retry alarm");
  await f.run();
  assert.equal(f.calls.length, 3, "failed requests never retry");
});

test("transient failures use the durable bounded backoff without blocking later requests", async () => {
  const f = fixture(); f.hold("retry"); f.hold("later");
  f.fail(id => id === "retry" ? Object.assign(new Error("Unavailable"), { status: 503 }) : undefined);
  for (const [index, delay] of [60_000, 300_000, 900_000].entries()) {
    await f.run();
    const retry = f.read("request:retry");
    assert.deepEqual(retry.inputAdmissionRetry, { attempts: index + 1, at: Date.now() + delay });
    assert.equal(f.deadlines.at(-1), Date.now() + delay);
    assert.equal((await requestView(retry)).inputAdmissionRetry, undefined);
    const calls = f.calls.length;
    await f.run();
    assert.equal(f.calls.length, calls, "settlement kicks respect the stored retry deadline");
    mock.timers.tick(delay);
  }
  assert.equal(f.read("request:later").accepted, true);
  await f.run();
  assert.equal(f.read("request:retry").status, "failed");
  assert.equal(f.deadlines.at(-1), Infinity);
  assert.deepEqual(f.events, [{ type: "response", id: "retry", outcome: { error: "Unavailable" } }]);
  assert.deepEqual(f.calls, ["retry", "later", "retry", "retry", "retry"]);
});

test("a recovered transient failure clears its retry and accepts exactly once", async () => {
  const f = fixture(); f.hold("retry");
  f.fail(() => new Error("Connection lost"));
  await f.run(); mock.timers.tick(60_000); f.fail(() => undefined);
  await f.run(); await f.run();
  assert.equal(f.read("request:retry").accepted, true);
  assert.equal(f.read("request:retry").inputAdmissionRetry, undefined);
  assert.deepEqual(f.calls, ["retry", "retry"]);
  assert.deepEqual(f.events, []);
});

test("an error after durable acceptance tracks the request instead of failing or retrying it", async () => {
  const f = fixture(); f.hold("accepted");
  f.fail(id => {
    f.values.set(`request:${id}`, { ...f.read(`request:${id}`), heldForInput: undefined, accepted: true });
    return new Error("Alarm write interrupted");
  });
  await f.run();
  assert.deepEqual(f.tracked, ["accepted"]);
  assert.deepEqual(f.deadlines, []); assert.deepEqual(f.events, []);
});

test("an interrupted error event does not keep later held requests from admission", async () => {
  const f = fixture(); f.hold("refused"); f.hold("later");
  f.fail(id => id === "refused" ? Object.assign(new Error("Credit refused"), { status: 402 }) : undefined);
  f.runtime.flushTerminalEvents = async () => { throw new Error("Event write interrupted"); };
  await assert.rejects(f.run(), /Event write interrupted/);
  assert.equal(f.read("request:refused").status, "failed");
  assert.equal(f.read("request:later").accepted, true);
  assert.equal(f.values.has("terminal-events:refused"), true, "the normal event outbox retains the error for delivery");
  await f.run();
  assert.deepEqual(f.calls, ["refused", "later"]);
});
