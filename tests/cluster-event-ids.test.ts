import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "../clients/typescript.ts";
import { cluster, fakeModel, jsExec, lookup, sleep, token, until } from "./cluster-helpers.ts";

type Node = Awaited<ReturnType<Awaited<ReturnType<typeof cluster>>["start"]>>;
const CLOCK_OFFSET = fileURLToPath(new URL("./fixtures/clock-offset.mjs", import.meta.url));

/**
 * Follow an agent's event stream as a watcher does, on whichever node is up, reconnecting with Last-Event-ID; after a
 * 409 (a gap) it starts over as a new subscriber, as a client does once it has recovered from the agent's state.
 */
function watch(nodes: Node[], agent: string) {
  const frames: { id: number; data: string; node: string }[] = [];
  const refused: { cursor: number; node: string }[] = [];
  const stop = new AbortController();
  let cursor = 0;
  const done = (async () => {
    while (!stop.signal.aborted) {
      const node = nodes.find(entry => entry.child.exitCode === null && entry.child.signalCode === null)!;
      try {
        const response = await fetch(`${node.url}/v1/agents/${agent}/events?snapshot=0`, { headers: { Authorization: `Bearer ${token}`, ...(cursor ? { "Last-Event-ID": String(cursor) } : {}) }, signal: stop.signal });
        if (!response.ok || !response.body) {
          if (response.status === 409) { refused.push({ cursor, node: node.name }); cursor = 0; }
          await response.body?.cancel();
          await sleep(100);
          continue;
        }
        let buffer = "";
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          for (let end; (end = buffer.indexOf("\n\n")) !== -1; buffer = buffer.slice(end + 2)) {
            const lines = buffer.slice(0, end).split("\n");
            const id = Number(lines.find(line => line.startsWith("id:"))?.slice(3));
            const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data || lines.includes("event: ready") || !Number.isSafeInteger(id)) continue;
            frames.push({ id, data, node: node.name });
            cursor = id;
          }
        }
      } catch { /* cut off, or stopped */ }
      await sleep(50);
    }
  })();
  return { frames, refused, stop: async () => { stop.abort(); await done; } };
}

test("event ids: a node whose clock is 20 s behind takes over from one that crashed, publishing only ids above the dead node's; a watcher holding its last id gets a 409", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  // A's second model call never answers: A dies while the turn runs, and B resumes it.
  const model = await fakeModel(t, (_body, index) => index === 0 ? jsExec('return await tools.lookup({ key: "k" })') : index === 1 ? undefined : { role: "assistant", content: "all done" });
  const a = await c.start("a", model.env);
  const b = await c.start("b", { ...model.env, NODE_OPTIONS: `--import=${CLOCK_OFFSET}`, AGENT_TEST_CLOCK_OFFSET_MS: "-20000" });
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: lookup([]), idempotencyKey: "skewed-takeover" });
  await created.close();
  const agent = created.session.id;
  const watcher = watch([a, b], agent);
  t.after(() => watcher.stop());
  const client = await new AgentRuntime({ url: b.url, apiKey: token }).connectAgent(created.session, { tools: lookup([]) });
  t.after(() => client.close());
  const run = client.prompt("go", { idempotencyKey: "turn", timeoutMs: 90_000 });
  await until(() => model.bodies.length === 2 && watcher.frames.length > 0, "A made the second model call, and the watcher has its events");
  // What A sent before it died.
  await sleep(300);
  const fromA = watcher.frames.filter(frame => frame.node === "a");
  const last = Math.max(...fromA.map(frame => frame.id));
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  assert.equal((await run).reply, "all done");
  await until(() => watcher.frames.some(frame => frame.node === "b" && frame.data.includes('"type":"response"')), "the watcher saw the turn end on B");
  await watcher.stop();

  const fromB = watcher.frames.filter(frame => frame.node === "b");
  assert.ok(fromB.length > 0);
  // B's clock reads 20 s before A's: still, every id it publishes is above every id A did, so none is reused.
  for (const frame of fromB) assert.ok(frame.id > last, `B published id ${frame.id}, at or below A's ${last}`);
  const sent = new Map<number, string>();
  for (const frame of watcher.frames) {
    assert.ok(!sent.has(frame.id) || sent.get(frame.id) === frame.data, `id ${frame.id} was sent for two events`);
    sent.set(frame.id, frame.data);
  }
  // The watcher holding A's last id was told of the gap, not resumed in the middle of B's stream.
  assert.ok(watcher.refused.some(entry => entry.cursor === last && entry.node === "b"), JSON.stringify(watcher.refused));
  // And so is any watcher resuming from any of A's ids: an exact suffix, or a 409.
  for (const { id } of fromA) {
    const response = await fetch(`${b.url}/v1/agents/${agent}/events?snapshot=0`, { headers: { Authorization: `Bearer ${token}`, "Last-Event-ID": String(id) } });
    await response.body?.cancel();
    assert.equal(response.status, 409, `a watcher resuming from A's id ${id} on B`);
  }
});
