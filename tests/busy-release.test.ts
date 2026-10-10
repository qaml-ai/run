import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentClient } from "../clients/node.ts";
import { echo, fixture, sleep } from "./client-fixture.ts";
import { check, fc } from "./prop-helpers.ts";

/**
 * A run's busy slot is free before the run is seen to end: a client that starts the next run as soon as it sees one end
 * (its response, its record) is never refused for it, however slowly the slot is given back (`releaseDelayMs`). Yet the
 * slot is held for the whole run, and given back however the run ends.
 */

/** A model that answers every turn at once. */
async function instantModel(t: { after: (fn: () => Promise<void>) => void }) {
  const provider = createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "ok" }, null], [{}, "stop"]]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  t.after(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  return { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 } as Model<Api>;
}

/**
 * Requests as a client makes them, without the SDK's retries (it retries a 429): `start` is refused unless it is taken (202),
 * and `ended` sees a request end by its record, waiting on it (`wait`), polling it, or as the SDK waits (`sdk`).
 */
function raw(f: Awaited<ReturnType<typeof fixture>>) {
  const read = async (agent: AgentClient, id: string, wait = 0) => await (await fetch(`${f.url}/clients/${agent.session.id}/requests/${id}${wait ? `?wait=${wait}` : ""}`, { headers: { Authorization: `Bearer ${agent.session.token}` } })).json() as any;
  return {
    async start(agent: AgentClient, id: string, method: "execute" | "prompt", params: object) {
      const accepted = await f.post(agent, "/requests", { id, method, params });
      assert.equal(accepted.status, 202, `${id}: ${accepted.status} ${await accepted.text()}`);
    },
    async ended(agent: AgentClient, id: string, how: "wait" | "poll" | "sdk") {
      if (how === "sdk") return agent.waitForRequest(id).catch(error => error);
      for (let record; ; await sleep(1)) if ((record = await read(agent, id, how === "wait" ? 25 : 0)).state === "completed") return record.outcome;
    },
  };
}

test("at a busy limit of 1, the next run on another agent is taken as soon as one is seen to end: executions and prompts, seen by wait, poll or SDK, 200 times each", { timeout: 300_000 }, async t => {
  const f = await fixture(t, { busyLimit: 1, releaseDelayMs: 25 });
  f.setModel(await instantModel(t));
  const client = raw(f);
  const agents = [await f.start(), await f.start()];
  const ways = ["wait", "poll", "sdk"] as const;
  for (const method of ["execute", "prompt"] as const) {
    for (let index = 0; index < 200; index++) {
      const agent = agents[index % 2], id = `${method}-${index}`;
      await client.start(agent, id, method, method === "execute" ? { code: `return ${index}` } : { text: `turn ${index}` });
      await client.ended(agent, id, ways[index % 3]);
    }
  }
  await sleep(100);
  assert.equal((await f.db.query("select count(*)::int as n from busy_agents")).rows[0].n, 0, "no slot is left held");
});

test("at a busy limit of 1, a running run holds its slot: another agent's run is refused until it ends, then starts at once", async t => {
  const f = await fixture(t, { busyLimit: 1, releaseDelayMs: 25, timeout: 30_000 });
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const busy = await f.start({ echo: echo(async () => { entered.resolve(); await release.promise; return "done"; }) });
  const other = await f.start();
  const running = busy.execute('return await tools.echo({value:"x"})');
  await entered.promise;
  for (let index = 0; index < 3; index++) {
    const refused = await f.post(other, "/requests", { id: `refused-${index}`, method: "execute", params: { code: "return 1" } });
    assert.equal(refused.status, 429);
    assert.equal((await refused.json() as any).code, "BUSY_AGENT_LIMIT");
  }
  // The busy agent's own next run queues behind its first: it is busy already, so it takes no new slot.
  const queued = busy.execute("return 2", { idempotencyKey: "queued" });
  release.resolve();
  assert.equal((await running).output[0], "done");
  // Its queued run keeps the agent busy until it too has ended.
  assert.equal((await queued).output[0], "2");
  await raw(f).start(other, "after", "execute", { code: "return 3" });
});

test("a run that fails, or is aborted, gives its slot back before it is seen to end", async t => {
  const f = await fixture(t, { busyLimit: 1, releaseDelayMs: 25, timeout: 30_000 });
  const entered = Promise.withResolvers<void>();
  const stuck = await f.start({ echo: echo(async () => { entered.resolve(); return new Promise(() => {}); }) });
  const other = await f.start();
  const client = raw(f);
  for (let index = 0; index < 20; index++) {
    await assert.rejects(stuck.execute(`throw new Error("boom ${index}")`), /boom/);
    await client.start(other, `after-failure-${index}`, "execute", { code: `return ${index}` });
    await client.ended(other, `after-failure-${index}`, "wait");
  }
  // Aborted mid-run: its outcome seen, the slot is free.
  const running = stuck.execute('return await tools.echo({value:"x"})', { idempotencyKey: "stuck" }).catch(error => error);
  await entered.promise;
  await stuck.abort();
  await running;
  await client.start(other, "after-abort", "execute", { code: "return 4" });
  await client.ended(other, "after-abort", "wait");
  // Queued runs cancelled by an abort, behind a run aborted with them: none of them holds the slot.
  const blocked = stuck.execute('return await tools.echo({value:"y"})', { idempotencyKey: "blocked" }).catch(error => error);
  const behind = [1, 2].map(index => stuck.execute(`return ${index}`, { idempotencyKey: `behind-${index}` }).catch(error => error));
  await sleep(100);
  await stuck.abort();
  await Promise.all([blocked, ...behind]);
  await client.start(other, "after-cancel", "execute", { code: "return 5" });
  await client.ended(other, "after-cancel", "wait");
  await sleep(100);
  assert.equal((await f.db.query("select count(*)::int as n from busy_agents")).rows[0].n, 0, "no slot is left held");
});

test("a run an abort cancels while it is still being accepted gives its slot back before it is seen to end", async t => {
  const f = await fixture(t, { busyLimit: 1, releaseDelayMs: 25, timeout: 30_000 });
  const idle = await f.start();
  const other = await f.start();
  const client = raw(f);
  // The run's record is taken, and its durable write held (a slow disk): it is still being accepted when the abort comes.
  const session = f.sessions.sessions.get(idle.session.id)!;
  const flush = session.log.flush.bind(session.log);
  const held = Promise.withResolvers<void>();
  session.log.flush = async (durable?: boolean) => { if (durable) await held.promise; return flush(durable); };
  const accepting = f.post(idle, "/requests", { id: "cancelled", method: "execute", params: { code: "return 1" } });
  for (let tries = 0; !session.requests.has("cancelled"); tries++) { assert.ok(tries < 1000, "the run was taken"); await sleep(5); }
  const aborting = f.sessions.abortAgent(idle.session.id, "default");
  for (let tries = 0; session.requests.get("cancelled")?.state !== "completed"; tries++) { assert.ok(tries < 1000, "the abort cancelled the run"); await sleep(5); }
  session.log.flush = flush;
  held.resolve();
  assert.deepEqual(await aborting, { cancelled: ["cancelled"] });
  assert.equal((await accepting).status, 202);
  assert.equal((await client.ended(idle, "cancelled", "poll")).result.code, "cancelled");
  await client.start(other, "after", "execute", { code: "return 2" });
  await client.ended(other, "after", "wait");
});

test("property: at a busy limit, runs that succeed, fail or are aborted across agents never exceed it, and the slot of every run seen to end is free", { timeout: 600_000 }, async t => {
  const limit = 2;
  const f = await fixture(t, { busyLimit: limit, releaseDelayMs: 10, timeout: 30_000 });
  let running = 0, peak = 0;
  const gates = new Map<string, PromiseWithResolvers<void>>();
  const agents = await Promise.all(Array.from({ length: 4 }, () => f.start({
    echo: echo(async ({ value }) => { running++; peak = Math.max(peak, running); try { await gates.get(value)!.promise; } finally { running--; } return value; }),
  })));
  const client = raw(f);
  let seq = 0;
  // Each step: hold up to `limit` agents in a run, see one more refused, then end them (succeed, fail or abort) and run on
  // another agent at once.
  const ending = fc.constantFrom("succeed" as const, "fail" as const, "abort" as const);
  await check(t, fc.asyncProperty(fc.array(fc.record({ held: fc.integer({ min: 1, max: limit }), endings: fc.array(ending, { minLength: limit, maxLength: limit }) }), { minLength: 1, maxLength: 4 }), async steps => {
    for (const step of steps) {
      const held = agents.slice(0, step.held).map((agent, index) => {
        const value = `run-${++seq}`;
        gates.set(value, Promise.withResolvers<void>());
        const code = step.endings[index] === "fail" ? `await tools.echo({value:${JSON.stringify(value)}}); throw new Error("failed")` : `return await tools.echo({value:${JSON.stringify(value)}})`;
        return { agent, value, ending: step.endings[index], done: agent.execute(code, { idempotencyKey: value }).catch(error => error) };
      });
      // Every call let go however the step ends, so the next case starts with none running.
      try {
        for (let tries = 0; running < held.length; tries++) { assert.ok(tries < 1000, "the held runs began"); await sleep(5); }
        if (step.held === limit) {
          const refused = await f.post(agents[limit], "/requests", { id: `refused-${++seq}`, method: "execute", params: { code: "return 0" } });
          assert.equal(refused.status, 429, "at the limit, another agent's run is refused");
        }
        for (const run of held) {
          if (run.ending === "abort") await run.agent.abort();
          else gates.get(run.value)!.resolve();
          await run.done;
          // Seen to end: another agent's run is taken at once.
          const next = `next-${++seq}`;
          await client.start(agents[limit + 1], next, "execute", { code: "return 1" });
          await client.ended(agents[limit + 1], next, "wait");
        }
      } finally {
        for (const run of held) gates.get(run.value)!.resolve();
        await Promise.all(held.map(run => run.done));
        for (let tries = 0; running; tries++) { assert.ok(tries < 1000, "the step's calls settled"); await sleep(5); }
      }
    }
    assert.ok(peak <= limit, `${peak} runs ran at once`);
  }), { runs: 5 });
});
