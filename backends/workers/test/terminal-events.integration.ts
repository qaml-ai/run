import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";

test("a completed run replays its terminal events after loss before delivery", { timeout: 90000 }, async t => {
  const f = await startFixture();
  t.after(() => f.stop());
  const headers = { authorization: `Bearer ${f.token}`, "content-type": "application/json" };
  const call = async (path: string, input?: unknown) => {
    const response = await fetch(f.url + path, { headers, method: input === undefined ? "GET" : "POST",
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    assert.ok(response.ok, `${response.status} ${path}`);
    return await response.json() as any;
  };
  const agent = (await call("/v1/agents", { model: "test/echo" })).id;
  const experimental = `/experimental/agents/${agent}`;
  const id = "run_terminal_recovery";
  await call(`${experimental}/__test/crash-next-settlement`, { events: true });
  await call(`/v1/agents/${agent}/requests`, { id, method: "prompt", params: { text: "recover terminal" } });
  let record: any;
  for (let n = 0; n < 100; n++) {
    record = await call(`/v1/agents/${agent}/requests/${id}?wait=1`);
    if (record.state === "completed") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(record.state, "completed");
  assert.equal((await call(`${experimental}/__test/settlement-state`)).crashReached, true);
  // The durable request exists, but neither terminal event has reached its log.
  await f.worker.stop(true);
  await f.worker.start();
  const read = async (cursor?: string) => {
    const response = await fetch(`${f.url}${experimental}/events?runId=${id}`, {
      headers: { ...headers, ...(cursor ? { "Last-Event-ID": cursor } : {}) }, signal: AbortSignal.timeout(10000),
    });
    assert.ok(response.ok);
    return (await response.text()).split("\n\n").filter(frame => frame.includes("data: ")).map(frame => ({
      cursor: /^id: (\d+)$/m.exec(frame)![1], value: JSON.parse(/^data: (.+)$/m.exec(frame)![1]),
    }));
  };
  const events = await read();
  assert.equal(events.filter(event => event.value.event?.type === "agent_end").length, 1);
  const terminals = events.filter(event => event.value.type === "response");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].value.outcome.result.reply, "Echo: recover terminal");
  const end = events.find(event => event.value.event?.type === "agent_end")!;
  const replay = await read(end.cursor);
  assert.deepEqual(replay.map(event => event.value.type), ["response"]);
  assert.equal(replay[0].cursor, terminals[0].cursor, "recovery must reuse the persisted terminal event");
});
