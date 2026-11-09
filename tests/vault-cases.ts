import assert from "node:assert/strict";
import type { Start } from "./github-apps-cases.ts";
export async function vaultApiCase(t: {after(fn:()=>Promise<void>|void):void}, start: Start) {
  const r = await start(t, () => ({role:"assistant",content:"ok"}), {});
  const path="/v1/secrets/TOKEN";
  for (const name of ["PATH", "HOME", "SSL_CERT_FILE", "NODE_OPTIONS", "LD_PRELOAD", "LD_CUSTOM", "NODE_EXTRA_CA_CERTS"]) {
    const refused = await r.call(`/v1/secrets/${name}`, {method:"POST",body:{value:"reserved-value",allowedHosts:[]}});
    assert.equal(refused.status,400,refused.text);
  }
  assert.equal((await r.call('/v1/secrets/SHORT',{method:'POST',body:{value:'1234567',allowedHosts:[]}})).status,400);
  for (const malformed of ['/v1/secrets/%zz','/v1/workspaces/%zz/secrets']) {
    const refused=await r.call(malformed,{method:malformed.endsWith('secrets')?'GET':'POST',body:malformed.endsWith('secrets')?undefined:{value:'long-value',allowedHosts:[]}});
    assert.equal(refused.status,400,refused.text);
  }
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

export async function vaultHostRulesCase(t: {after(fn:()=>Promise<void>|void):void}, start: Start) {
  const r = await start(t, () => ({ role: "assistant", content: "ok" }), {});
  const allowedHosts = ["httpbin.org", "postman-echo.com", "herokuapp.com", "foo.herokuapp.com", "github.io", "*.foo.herokuapp.com"];
  const created = await r.call("/v1/secrets/HOST_POLICY", { method: "POST", body: { value: "host-policy-value", allowedHosts } });
  assert.equal(created.status, 200, created.text);
  // Unrestricted still validates its host rules; Node deliberately refuses limited networking.
  const definition = await r.call("/v1/definitions", { body: { name: "Private suffix hosts", networking: { type: "unrestricted", allowedHosts } } });
  assert.equal(definition.status, 201, definition.text);
  assert.deepEqual(definition.json.networking.allowedHosts, allowedHosts);
  for (const host of ["com", "co.uk", "*.com", "*.co.uk", "*.httpbin.org", "*.postman-echo.com", "*.herokuapp.com", "*.github.io", "127.0.0.1", "metadata.internal"]) {
    const secret = await r.call("/v1/secrets/HOST_POLICY", { method: "PATCH", body: { allowedHosts: [host] } });
    assert.equal(secret.status, 400, `${host}: ${secret.text}`);
    const policy = await r.call(`/v1/definitions/${definition.json.id}`, { method: "PATCH", body: { networking: { type: "unrestricted", allowedHosts: [host] } } });
    assert.equal(policy.status, 400, `${host}: ${policy.text}`);
  }
  assert.deepEqual((await r.call(`/v1/definitions/${definition.json.id}`)).json.networking.allowedHosts, allowedHosts);
}
