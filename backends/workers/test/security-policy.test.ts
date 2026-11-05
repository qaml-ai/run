import { test } from "node:test";
import assert from "node:assert/strict";
import { configuration } from "../src/api-contract.ts";
import { actorInput } from "../src/security-policy.ts";

test("agent identity limits count UTF-8 JSON bytes like the source", () => {
  assert.equal(configuration({ subject: "subject", context: { note: "é".repeat(2000) } }, "test/model").config.subject, "subject");
  assert.throws(() => configuration({ context: { note: "é".repeat(2048) } }, "test/model"), /at most 4 KB/);
  for (const subject of [" ", "x".repeat(201), null]) assert.throws(() => configuration({ subject }, "test/model"), /subject must be/);
  assert.deepEqual(configuration({ context: { app: "builder" } }, "test/model").config.context, { app: "builder" });
  assert.equal(actorInput(undefined), undefined);
  assert.throws(() => actorInput(" "), /actor must be/);
});

test("bucket and keyScope names use the source grammars", () => {
  assert.equal(configuration({ bucket: "bot:42/segment@1", keyScope: "org-abc.123" }, "test/model").config.bucket, "bot:42/segment@1");
  assert.equal(configuration({ bucket: null }, "test/model").config.bucket, undefined);
  for (const bucket of ["has spaces", "x".repeat(101), "é", 12]) assert.throws(() => configuration({ bucket }, "test/model"), /bucket must be/);
  for (const keyScope of ["-leading", "has spaces", "x".repeat(101), "org:1", null]) assert.throws(() => configuration({ keyScope }, "test/model"), /keyScope must be/);
});

test("spendLimit accepts source dollar objects and null, and rejects numeric or unbounded values", () => {
  assert.deepEqual(configuration({ spendLimit: { usd: 1.5 } }, "test/model").config.spendLimit, { usd: 1.5 });
  assert.deepEqual(configuration({ spendLimit: { usd: 0 } }, "test/model").config.spendLimit, { usd: 0 });
  assert.equal(configuration({ spendLimit: null }, "test/model").config.spendLimit, null);
  for (const spendLimit of [1.5, {}, { usd: -1 }, { usd: 1_000_001 }, { usd: Infinity }, { usd: 1, extra: true }]) assert.throws(() => configuration({ spendLimit }, "test/model"), /spendLimit must be/);
});
