import { test } from "node:test";
import assert from "node:assert/strict";
import { purgeStart } from "../src/account-purge.ts";

function storage(entries: Record<string, unknown>) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    async get<T>(key: string) { return data.get(key) as T | undefined; },
    async put(key: string, value: unknown) { data.set(key, value); },
    async list({ limit }: { limit: number }) { return new Map([...data].slice(0, limit)); },
  };
}

test("an account purge erases only the owned, deleted agent, and one cut short after erasing only needs its mark", async () => {
  assert.equal(await purgeStart(storage({ deleted: true, configuration: { tenantId: "t", id: "a" } }), "t", "a"), "erase");
  assert.equal(await purgeStart(storage({ deleted: true }), "t", "a"), "erase", "purged before: erasing again is harmless");

  // The process died between deleteAll() and put("deleted"): a retried deletion pass must not fail on it forever.
  const erased = storage({});
  assert.equal(await purgeStart(erased, "t", "a"), "done");
  assert.deepEqual([...erased.data], [["deleted", true]]);

  const refused = /owned, deleted agent/;
  await assert.rejects(purgeStart(storage({ configuration: { tenantId: "t", id: "a" } }), "t", "a"), refused, "a live agent");
  await assert.rejects(purgeStart(storage({ "history:1": "x" }), "t", "a"), refused, "storage that is not empty");
  await assert.rejects(purgeStart(storage({ deleted: true, configuration: { tenantId: "other", id: "a" } }), "t", "a"), refused);
  await assert.rejects(purgeStart(storage({ deleted: true, configuration: { tenantId: "t", id: "b" } }), "t", "a"), refused);
});
