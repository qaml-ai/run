import { test } from "node:test";
import assert from "node:assert/strict";
import { providerCredentials, type KeyServices } from "../src/security-services.ts";

/** Key services whose only key is the tenant's `source` key for every provider. */
function services(source: "tenant" | "admin" | "platform") {
  return { services: {
    accounts: { providerKey: async () => ({ key: `${source}-key`, source }) },
    keyScopes: { entry: async () => undefined },
    modelProviders: { credentials: async () => undefined },
  } as unknown as KeyServices };
}

test("only the platform's own key charges platform credit: an operator's entry key (admin) is the tenant's (media: test/media-keys.integration.ts)", async () => {
  for (const [source, platform] of [["tenant", false], ["admin", false], ["platform", true]] as const) {
    const model = services(source);
    const resolved = await providerCredentials(model.services, "t", "openrouter");
    assert.deepEqual([source, resolved?.apiKey, resolved?.platform], [source, `${source}-key`, platform], "model calls");
  }
});
