import assert from "node:assert/strict";
import type { Start } from "./github-apps-cases.ts";
export async function vaultApiCase(t: {after(fn:()=>Promise<void>|void):void}, start: Start) {
  const r = await start(t, () => ({role:"assistant",content:"ok"}), {});
  const path="/v1/secrets/TOKEN";
  const created=await r.call(path,{method:"POST",body:{value:"write-only-value",allowedHosts:["api.stripe.com"]}});
  assert.equal(created.status,200,created.text); assert.deepEqual(created.json,{name:"TOKEN"});
  const list=await r.call("/v1/secrets"); assert.equal(list.status,200,list.text); assert.deepEqual(list.json,["TOKEN"]);
  assert.equal((await r.call(path)).status,404);
  assert.equal((await r.call(path,{method:"POST",body:{value:"duplicate-value",allowedHosts:[]}})).status,409);
  assert.equal((await r.call(path,{method:"PATCH",body:{value:"rotated-value"}})).status,200);
  assert.equal((await r.call(path,{method:"PATCH",body:{allowedHosts:["*.co.uk"]}})).status,400);
  const workspace="/v1/workspaces/vault-test/secrets/TOKEN";
  assert.equal((await r.call(workspace,{method:"POST",body:{value:"workspace-value",allowedHosts:[]}})).status,200);
  assert.deepEqual((await r.call("/v1/workspaces/vault-test/secrets")).json,["TOKEN"]);
  assert.equal((await r.call(path,{method:"DELETE"})).status,200);
  assert.deepEqual((await r.call("/v1/secrets")).json,[]);
  assert.deepEqual((await r.call("/v1/workspaces/vault-test/secrets")).json,["TOKEN"]);
  assert.equal((await r.call(workspace,{method:"DELETE"})).status,200);
  assert.ok(!r.logs.join("\n").includes("write-only-value"));
}
