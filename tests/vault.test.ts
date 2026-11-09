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
  const result=await maskResponse(new Response(stream,{headers:{"x-echo":"secret-value","content-type":"text/event-stream"}}),["secret-value"]);
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

test('reserved environment names, short values and malformed encoding are refused', async () => {
  const {secretName,decodeVaultPath} = await import('../src/core/vault.ts');
  for (const name of ['PATH','HOME','SSL_CERT_FILE','NODE_OPTIONS','LD_PRELOAD','LD_ANYTHING','NODE_EXTRA_CA_CERTS']) assert.throws(()=>secretName(name),/reserved/);
  process.env.VAULT_OCCUPIED_TEST='present';
  try { assert.throws(()=>secretName('VAULT_OCCUPIED_TEST',Object.keys(process.env)),/reserved/); } finally {delete process.env.VAULT_OCCUPIED_TEST;}
  await assert.rejects(vault().put('a','TOKEN',{value:'short',allowedHosts:[]},'',true),/8–8192/);
  assert.throws(()=>decodeVaultPath('%zz'),(e:any)=>e.status===400);
  const short = new Response('tiny',{headers:{etag:'"original"'}});
  assert.equal(await maskResponse(short,['tiny']),short);
});

test('request bodies stream without a cap unless the attached reference opts into body substitution',async()=>{
  let opened=0;
  const lazy=async()=>{opened++;return vault();};
  const huge=new Uint8Array(8*1024*1024+1);
  const request=new Request('https://api.stripe.com',{method:'POST',body:huge});
  const result=await vaultRequest(request,[{type:'vault',name:'TOKEN'}],lazy,'a');
  assert.equal((await result.request.arrayBuffer()).byteLength,huge.length);
  assert.equal(opened,0);
  await assert.rejects(vaultRequest(new Request('https://api.stripe.com',{method:'POST',body:huge}),[{type:'vault',name:'TOKEN',inBody:true}],lazy,'a'),(e:any)=>e.status===413);
  const v=vault();await v.put('a','TOKEN',{value:'body-secret',allowedHosts:['api.stripe.com'],locations:['body']},'',true);
  const body=await vaultRequest(new Request('https://api.stripe.com',{method:'POST',body:secretPlaceholder('TOKEN'),headers:{'content-length':String(secretPlaceholder('TOKEN').length)}}),[{type:'vault',name:'TOKEN',inBody:true}],v,'a');
  assert.equal(body.request.headers.get('content-length'),null);
  assert.equal(await body.request.text(),'body-secret');
});

test('binary responses bypass masking and unchanged text keeps validators',async()=>{
  const bytes=new Uint8Array([0,255,1,2,3]);
  const pack=new Response(bytes,{headers:{'content-type':'application/x-git-upload-pack-result',etag:'"pack"','content-length':'5'}});
  assert.equal(await maskResponse(pack,['long-secret']),pack);
  const original=new Response('public text',{headers:{'content-type':'text/plain',etag:'"text"','content-length':'11'}});
  const unchanged=await maskResponse(original,['long-secret']);
  assert.equal(unchanged.headers.get('etag'),'"text"');assert.equal(unchanged.headers.get('content-length'),'11');assert.equal(await unchanged.text(),'public text');
  const changed=await maskResponse(new Response('long-secret',{headers:{'content-type':'text/plain',etag:'"text"','content-length':'11'}}),['long-secret']);
  assert.equal(changed.headers.get('etag'),null);assert.equal(changed.headers.get('content-length'),null);assert.equal(await changed.text(),'[hidden]');
});

test('MCP cross-origin token requests drop credentials; vault requests refuse them', async t=>{
  const {McpConnections}=await import('../src/mcp.ts');
  let minted=0; const seen:any[]=[];
  const connections=new McpConnections({outbound:{fetch:async(url:any,init:any)=>{seen.push({url,init});return new Response('public');}} as any});
  t.after(()=>connections.close());
  const server={url:'https://mcp.example.com',headers:{authorization:'static-secret'},token:async()=>{minted++;return 'dynamic-secret';}};
  const fetcher=(connections as any).fetcher(server);
  await fetcher('https://other.example.com');
  assert.equal(minted,0);assert.deepEqual(seen[0].init.secrets,{});
  await assert.rejects((connections as any).fetcher({...server,vault:true})('https://other.example.com'),/cannot change origin/);
  assert.equal(seen.length,1);
  await fetcher('https://mcp.example.com');assert.equal(minted,1);assert.equal(seen[1].init.secrets.Authorization,'Bearer dynamic-secret');
});


test('runtime binding names and invalid body opt-in are refused before storage',async()=>{
  const v=vault(); const restricted=new Vault(v.sql,{...v.keys,reservedNames:['RUNTIME_BINDING']});
  await assert.rejects(restricted.put('a','RUNTIME_BINDING',{value:'long-value',allowedHosts:[]},'',true),/reserved/);
  assert.deepEqual(await restricted.list('a'),[]);
  const {vaultAuth}=await import('../src/core/vault.ts');
  assert.throws(()=>vaultAuth({type:'vault',name:'TOKEN',inBody:'yes'}),/inBody must be boolean/);
  await assert.rejects(vaultRequest(new Request('https://example.com/?key=%zz'),[],v,'a'),(e:any)=>e.status===400);
  await v.put('a','TOKEN',{value:'long-value',allowedHosts:['example.com']},'',true);
  await assert.rejects(vaultRequest(new Request('https://example.com',{method:'POST',body:secretPlaceholder('TOKEN')}),[{type:'vault',name:'TOKEN',inBody:true}],v,'a'),/not allowed/);
});
