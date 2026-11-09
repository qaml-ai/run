import { test } from "node:test";
import assert from "node:assert/strict";
import { runtime } from "./runtime-server.ts";
import { vaultApiCase, vaultHostRulesCase } from "./vault-cases.ts";
test("vault API: write-only values, rotation, scopes and deletion", t => vaultApiCase(t, runtime));
test("vault and network policies allow exact private-suffix hosts and refuse suffix wildcards", t => vaultHostRulesCase(t, runtime));

test("Node refuses limited networking with a clear client error", async t => {
  const r=await runtime(t,()=>({role:"assistant",content:"ok"}));
  const answer=await r.call("/v1/agents",{body:{networking:{type:"limited",allowedHosts:["api.stripe.com"]}}});
  assert.equal(answer.status,400,answer.text);
  assert.match(answer.json.error,/Limited networking is unavailable/);
});
