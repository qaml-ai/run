import assert from "node:assert/strict";
import test from "node:test";
import { ConfigurationTargets } from "../src/configuration-targets.ts";
import { firstPrompt } from "../src/first-prompt.ts";

function memoryStorage() {
  const data = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    delete: async (key: string) => data.delete(key),
    list: async ({ prefix, limit }: { prefix: string; limit?: number }) => new Map([...data].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)),
    transaction: async (run: (tx: unknown) => unknown) => run(storage),
  };
  return storage as unknown as DurableObjectStorage;
}

test("configuration targets survive a restart and apply in order after the running turn", async () => {
  const storage = memoryStorage(), seen: string[] = [], records: string[] = [];
  let busy = true, current = "A";
  const host = { busy: async () => busy, apply: async (target: { config: { systemPrompt?: string } }) => {
    const next = target.config.systemPrompt!; seen.push(next);
    const changed = current !== next; current = next;
    return { changed, configHash: next };
  }, emit: async (record: { id: string }) => { records.push(record.id); } };
  let queue = new ConfigurationTargets(storage, host);
  for (const [id, systemPrompt] of [["one", "B"], ["two", "A"], ["three", "B"]])
    await queue.enqueue({ id, config: { systemPrompt } });
  await queue.drain(); assert.deepEqual(seen, []);
  queue = new ConfigurationTargets(storage, host); busy = false;
  await Promise.all([queue.drain(), queue.drain()]);
  assert.deepEqual(seen, ["B", "A", "B"]);
  assert.deepEqual(records, ["one", "two", "three"]);
  assert.equal(await queue.pending(), false);
  const same = await queue.enqueue({ id: "four", config: { systemPrompt: "B" } });
  assert.equal((await queue.enqueue({ id: "four", config: { systemPrompt: "B" } })).id, same.id);
  await assert.rejects(queue.enqueue({ id: "four", config: { systemPrompt: "C" } }), /different configuration/);
  await queue.drain();
  assert.equal((await storage.get<any>("request:four")).outcome.result.changed, false);
});

test("first prompts reject malformed requests before provisioning", () => {
  assert.throws(() => firstPrompt({ requestId: "empty" }), /Send/);
  assert.throws(() => firstPrompt({ text: "hi", metadata: { count: 3 } }), /metadata/);
  const request = firstPrompt({ text: "hi", requestId: "first", metadata: { source: "web" } })!;
  assert.deepEqual(request, { id: "first", method: "prompt", params: { text: "hi", metadata: { source: "web" } } });
});
