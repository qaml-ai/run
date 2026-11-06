import { test } from "node:test";
import assert from "node:assert/strict";
import { chargesPlatform } from "../src/core/key-source.ts";

test("only the platform's own key charges platform credit: the tenant's and an operator's entry key (admin) never do", () => {
  assert.deepEqual((["tenant", "admin", "platform"] as const).map(chargesPlatform), [false, false, true]);
});
