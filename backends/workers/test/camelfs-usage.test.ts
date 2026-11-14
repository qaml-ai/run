import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeVmPayer, encodeVmPayer } from "../src/camelfs/usage.ts";

test("camelFS payer JSON preserves its owner and fixed rate", () => {
  for (const payer of [
    { tenant: "tenant", agent: "agent", rate: 0 },
    { tenant: "tenant", agent: "workflow", kind: "workflow" as const, rate: 0.002 },
  ]) {
    assert.equal(encodeVmPayer(payer), JSON.stringify(payer));
    assert.deepEqual(decodeVmPayer(encodeVmPayer(payer)), payer);
  }
});

test("camelFS payer rejects malformed JSON, owners and rates", () => {
  for (const payer of [
    "not JSON", "null", "[]", "{}", '{"tenant":"t","agent":"a","rate":1e999}',
    '{"tenant":"t","agent":"a","rate":-1}', '{"tenant":"t","agent":"a","rate":"1"}',
    '{"tenant":"","agent":"a","rate":1}', '{"tenant":"t","agent":"","rate":1}',
    '{"tenant":"t","agent":"a","rate":1,"kind":"agent"}',
  ]) assert.equal(decodeVmPayer(payer), undefined, payer);
});
