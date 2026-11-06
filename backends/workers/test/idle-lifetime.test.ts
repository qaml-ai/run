import assert from "node:assert/strict";
import test from "node:test";
import { nextIdleExpiry } from "../src/idle-lifetime.ts";

test("idle expiry extends used agents only after half their lifetime", () => {
  const configuration = { id: "agent", tenantId: "tenant", revision: 1, expiresAt: 600_000, config: { idleTtlSeconds: 600 } };
  assert.equal(nextIdleExpiry(configuration, 299_999), undefined);
  assert.equal(nextIdleExpiry(configuration, 300_000), 900_000);
  assert.equal(nextIdleExpiry(configuration, 599_999), 1_199_999);
  assert.equal(nextIdleExpiry(configuration, 600_000), undefined, "use cannot resurrect an expired agent");
  assert.equal(nextIdleExpiry({ ...configuration, expiresAt: null }, 300_000), undefined);
  assert.equal(nextIdleExpiry({ ...configuration, config: {} }, 300_000), undefined);
});
