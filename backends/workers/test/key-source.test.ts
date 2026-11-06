import { test } from "node:test";
import assert from "node:assert/strict";
import { providerCredentials, type KeyServices } from "../src/security-services.ts";
import { mediaKey } from "../src/media-api.ts";

/** Key services whose only key is the tenant's `source` key for every provider; `checks` lists the credit checks made. */
function services(source: "tenant" | "admin" | "platform") {
  const checks: string[] = [];
  return { checks, services: {
    accounts: { providerKey: async () => ({ key: `${source}-key`, source }), billing: { creditLimit: async (tenant: string) => { checks.push(tenant); return undefined; } } },
    keyScopes: { entry: async () => undefined },
    modelProviders: { credentials: async () => undefined },
  } as unknown as KeyServices };
}

test("only the platform's own key charges platform credit: an operator's entry key (admin) is the tenant's, for models and media alike", async () => {
  for (const [source, platform] of [["tenant", false], ["admin", false], ["platform", true]] as const) {
    const model = services(source);
    const resolved = await providerCredentials(model.services, "t", "openrouter");
    assert.deepEqual([source, resolved?.apiKey, resolved?.platform], [source, `${source}-key`, platform], "model calls");
    const media = services(source);
    const key = await mediaKey({} as never, "t", undefined, "openai", media.services);
    assert.deepEqual([source, key?.apiKey, key?.platform], [source, `${source}-key`, platform], "transcription, images and speech");
    assert.deepEqual(media.checks, platform ? ["t"] : [], "only a platform key checks credit");
  }
});
