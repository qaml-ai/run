import assert from "node:assert/strict";
import test from "node:test";
import { ConfigurationTargets, type ConfigurationTarget } from "../src/configuration-targets.ts";

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
  const host = { busy: async () => busy, apply: async (target: ConfigurationTarget) => {
    const next = target.config!.systemPrompt!; seen.push(next);
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
  await assert.rejects(queue.enqueue({ id: "four", config: { systemPrompt: "C" } }), /different input/);
  await queue.drain();
  assert.equal((await storage.get<any>("request:four")).outcome.result.changed, false);
});

test("a failed configuration records its outcome and the next one still applies", async () => {
  const storage = memoryStorage();
  const applied: string[] = [];
  const queue = new ConfigurationTargets(storage, {
    busy: async () => false,
    apply: async target => {
      if (target.id === "bad") throw new Error("Missing provider key");
      applied.push(target.id);
      return { changed: true, configHash: target.id };
    },
    emit: async () => {},
  });
  await queue.enqueue({ id: "bad", params: { model: "missing/model" } });
  await queue.enqueue({ id: "good", params: { systemPromptAppend: "Thread" } });
  await queue.drain();
  assert.deepEqual(applied, ["good"]);
  assert.equal((await storage.get<any>("request:bad")).outcome.error, "Missing provider key");
  assert.equal((await storage.get<any>("request:good")).state, "completed");
});

test("replacement targets retain their mode across restart and differ from patches", async () => {
  const storage = memoryStorage();
  const applied: ConfigurationTarget[] = [];
  const host = {
    busy: async () => false,
    apply: async (target: ConfigurationTarget) => {
      applied.push(target);
      return { changed: true, configHash: target.id };
    },
    emit: async () => {},
  };
  const queue = new ConfigurationTargets(storage, host);
  const target = { id: "replace", params: {}, replace: true as const };
  await queue.enqueue(target);
  await queue.enqueue(target);
  await assert.rejects(queue.enqueue({ id: "replace", params: {} }), /different input/);
  await new ConfigurationTargets(storage, host).drain();
  assert.deepEqual(applied, [target]);
});
