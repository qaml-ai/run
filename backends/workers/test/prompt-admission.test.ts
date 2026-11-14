import assert from "node:assert/strict";
import test from "node:test";
import { PromptPreparations, PROMPT_PREPARATION_PREFIX } from "../src/prompt-admission.ts";

function fixture() {
  const values = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => values.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
  } as unknown as DurableObjectStorage;
  let admitted = 0, released = 0;
  const snapshot = { spend: null, childCostAtAdmission: 0, most: { maxResponses: 10, maxSeconds: 60 } };
  const release = async () => { released++; };
  const preparations = new PromptPreparations(storage, release);
  const input = { tenant: "tenant", agent: "agent", requestId: "request", fingerprint: "digest-only" };
  return { values, storage, preparations, input, release, snapshot, admit: async () => { admitted++; return snapshot; }, counts: () => ({ admitted, released }) };
}

test("preparing a prompt admits once, retains no input, and transfers its slot to the sanitized request", async () => {
  const f = fixture();
  assert.deepEqual(await f.preparations.begin(f.input, f.admit, 100), f.snapshot);
  assert.deepEqual(await f.preparations.begin(f.input, f.admit, 100), f.snapshot);
  assert.deepEqual(f.counts(), { admitted: 1, released: 0 });
  assert.deepEqual(Object.keys(f.values.get(PROMPT_PREPARATION_PREFIX + "request") as object).sort(), ["admitted", "agent", "expiresAt", "fingerprint", "limitsSnapshot", "requestId", "tenant"]);
  await f.storage.put("request:request", { admitted: true, fingerprint: f.input.fingerprint });
  // Restart between the durable request write and deleting the preparation.
  await new PromptPreparations(f.storage, f.release).sweep(101, true);
  assert.deepEqual(f.counts(), { admitted: 1, released: 0 });
  assert.equal(f.values.has(PROMPT_PREPARATION_PREFIX + "request"), false);
});

test("failed and interrupted prompt preparation release their admission", async () => {
  const f = fixture();
  await f.preparations.begin(f.input, f.admit, 100);
  await f.preparations.fail("request");
  assert.deepEqual(f.counts(), { admitted: 1, released: 1 });
  await f.preparations.begin(f.input, f.admit, 200);
  await new PromptPreparations(f.storage, f.release).sweep(201, true);
  assert.deepEqual(f.counts(), { admitted: 2, released: 2 });
  assert.equal(f.values.size, 0);
});
