import { test } from "node:test";
import assert from "node:assert/strict";
import { hostRules, hostMatches, maskResponse, networkAllows, networkingInput, secretPlaceholder, Vault, vaultRequest } from "../src/core/vault.ts";

function vault() {
  const rows = new Map<string, any>();
  const key = (v: unknown[]) => JSON.stringify(v.slice(0,3));
  return new Vault({ async query(sql: string, v: unknown[] = []) {
    if (sql.startsWith("select name")) return { rows: [...rows].filter(([k]) => k.startsWith(JSON.stringify(v).slice(0,-1))).map(([,r]) => ({ name: r.name })), rowCount: 0 };
    if (sql.startsWith("select")) return { rows: rows.has(key(v)) ? [rows.get(key(v))] : [], rowCount: 0 };
    if (sql.startsWith("delete")) return { rows: [], rowCount: Number(rows.delete(key(v))) };
    rows.set(key(v), { name:v[2], policy:JSON.parse(v[3] as string), sealed:JSON.parse(v[4] as string) });
    return { rows: [], rowCount: 1 };
  } } as any, { canStore:true, seal: (ctx,text) => ({iv:ctx,tag:"",ciphertext:btoa(text)}), unseal: (ctx,v) => { assert.equal(ctx,v.iv); return atob(v.ciphertext); } });
}
test("vault host rules reject suffixes, private literals and private DNS; wildcards are label bounded", () => {
  for (const host of ["com","co.uk","*.co.uk","github.io","*.pages.dev","127.0.0.1","0177.0.0.1","[::1]","metadata.internal","x.local","x.example","foo.com:443"]) assert.throws(() => hostRules([host]), { name: "Error" }, host);
  assert.deepEqual(hostRules(["API.Stripe.com","*.example.com"]), ["api.stripe.com","*.example.com"]);
  assert.ok(hostMatches("a.example.com","*.example.com"));
  assert.ok(!hostMatches("example.com","*.example.com"));
  assert.ok(!hostMatches("evil-example.com","*.example.com"));
});
test("vault is scope isolated, write-only, rotatable and revocable at each request", async () => {
  const v = vault(); const ref = {type:"vault" as const,name:"TOKEN"};
  await v.put("a","TOKEN",{value:"secret-value",allowedHosts:["api.stripe.com"]},"",true);
  assert.deepEqual(await v.list("a"),["TOKEN"]);
  await assert.rejects(v.open("b",ref,new URL("https://api.stripe.com"),"header"));
  await assert.rejects(v.open("a",{...ref,workspace:"w"},new URL("https://api.stripe.com"),"header"));
  for (const url of ["http://api.stripe.com","https://evil.com","https://api.stripe.com:444"]) await assert.rejects(v.open("a",ref,new URL(url),"header"));
  await assert.rejects(v.open("a",ref,new URL("https://api.stripe.com"),"query"));
  await v.put("a","TOKEN",{value:"new-value"}); assert.equal(await v.open("a",ref,new URL("https://api.stripe.com"),"header"),"new-value");
  await v.remove("a","TOKEN"); await assert.rejects(v.open("a",ref,new URL("https://api.stripe.com"),"header"));
});
test("only attached placeholders at allowed locations are filled", async () => {
  const v=vault(), ref={type:"vault" as const,name:"TOKEN"}, placeholder=secretPlaceholder("TOKEN");
  await v.put("a","TOKEN",{value:"test-value",allowedHosts:["api.stripe.com"]},"",true);
  const filled=await vaultRequest(new Request("https://api.stripe.com",{headers:{authorization:`Bearer ${placeholder}`}}),[ref],v,"a");
  assert.equal(filled.request.headers.get("authorization"),"Bearer test-value");
  await assert.rejects(vaultRequest(new Request(`https://api.stripe.com/?key=${placeholder}`),[ref],v,"a"));
  await assert.rejects(vaultRequest(new Request("https://evil.com",{headers:{authorization:placeholder}}),[ref],v,"a"));
  await assert.rejects(vaultRequest(new Request("https://api.stripe.com",{headers:{authorization:placeholder}}),[],v,"a"));
});
test("response masking spans binary chunks, encoded echoes and headers without buffering ordinary SSE", async () => {
  const text=new TextEncoder();
  const stream=new ReadableStream({start(c){c.enqueue(text.encode("data: hello\n\n"));c.enqueue(text.encode("secr"));c.enqueue(text.encode("et-value"));c.close();}});
  const result=await maskResponse(new Response(stream,{headers:{"x-echo":"secret-value"}}),["secret-value"]);
  const reader=result.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value),"data: hello\n\n");
  let rest=""; for (;;) {const r=await reader.read();if(r.done)break;rest+=new TextDecoder().decode(r.value);}
  assert.equal(rest,"[hidden]");assert.equal(result.headers.get("x-echo"),"[hidden]");
});
test("network rules grant package hosts and MCP hosts only when explicitly enabled", () => {
  const p=networkingInput({type:"limited",allowedHosts:["*.example.com"]});
  assert.ok(networkAllows(p,new URL("https://a.example.com")));
  assert.ok(!networkAllows(p,new URL("https://registry.npmjs.org")));
  assert.ok(networkAllows({...p,allowPackageManagers:true},new URL("https://registry.npmjs.org")));
  assert.ok(!networkAllows(p,new URL("https://mcp.example.net"),["mcp.example.net"]));
  assert.ok(networkAllows({...p,allowMcpServers:true},new URL("https://mcp.example.net"),["mcp.example.net"]));
});

test("vault response masking covers JSON-escaped echoes", async () => {
  const value = 'key-"slash\\secret';
  const response = await maskResponse(new Response(JSON.stringify({ value })), [value]);
  assert.deepEqual(await response.json(), { value: "[hidden]" });
  assert.equal(await (await maskResponse(new Response("unchanged"), [""])).text(), "unchanged");
});

test("vault proxy preserves binary request bytes without a placeholder", async () => {
  const bytes=new Uint8Array([0,255,254,128,1]);
  const v=vault();
  const result=await vaultRequest(new Request("https://api.stripe.com",{method:"POST",body:bytes}),[{type:"vault",name:"TOKEN"}],v,"a");
  assert.deepEqual(new Uint8Array(await result.request.arrayBuffer()),bytes);
});
