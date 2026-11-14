import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { runCamelfsRefsCases } from "../../../tests/contract/camelfs-refs-cases.ts";
import { mintCamelfsToken } from "./camelfs-token.ts";
import { serveFakeCamelfsd } from "./fake-camelfsd.ts";

test("camelFS refs contract against the strict fake", async t => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = "refs-contract", issuer = "https://refs-contract.example";
  let now = Date.now();
  let hook: (() => Promise<void>) | undefined;
  const fake = await serveFakeCamelfsd("shared-bearer", {
    issuer,
    jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid }] },
    now: () => now,
    async beforeWriteMove() {
      const next = hook;
      hook = undefined;
      await next?.();
    },
  });
  t.after(fake.close);
  await runCamelfsRefsCases(t, {
    url: fake.url, issuer,
    mint: (claims, header) => mintCamelfsToken(privateKey, kid, claims, header),
    now: () => now,
    advance: ms => { now += ms; },
    interceptWrite: next => { hook = next; },
    async seedHistory(lineage, tree, parent, length) {
      for (let i = 0; i < length; i++) {
        ({ commit: parent } = await fake.checkpoint({ lineage, tree, parent }, "refs-contract"));
      }
      return parent;
    },
  });
});
