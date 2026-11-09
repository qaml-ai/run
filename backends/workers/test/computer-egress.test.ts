import assert from "node:assert/strict";
import test from "node:test";
import {
  computerSettingsInput,
  egressDescription,
  forwardEgress,
  CONTAINER_CA,
  type EgressGrant,
} from "../src/computers/egress.ts";
import { ContainerProvider, operate, type ComputerNetwork } from "../src/computers/provider.ts";

const check = (value: unknown) => {
  const url = new URL(String(value));
  if (url.protocol !== "https:") throw new Error("Only https:// URLs are allowed");
  return url;
};
const exchange = { type: "exchange" as const, url: "https://app.example.net/token" };

test("computer settings: hosts are public DNS names, auth is an exchange, scheme needs auth", () => {
  assert.deepEqual(computerSettingsInput({ egress: [{ host: "github.com", auth: exchange, scheme: "basic" }, { host: "registry.npmjs.org" }], idleSeconds: 900, instance: "standard-2" }, check, "acme"), {
    egress: [{ host: "github.com", auth: { type: "exchange", url: "https://app.example.net/token" }, scheme: "basic" }, { host: "registry.npmjs.org" }],
    idleSeconds: 900,
    instance: "standard-2",
  });
  // An exchange grant defaults to a bearer header.
  assert.equal(computerSettingsInput({ egress: [{ host: "api.github.com", auth: exchange }] }, check, "acme").egress![0].scheme, "bearer");
  for (const [value, message] of [
    [[], /must be an object/],
    [{ network: true }, /Unrecognized key: "network"/],
    [{ idleSeconds: 5 }, /idleSeconds must be an integer from 10 to 3600/],
    [{ instance: "huge" }, /instance must be one of lite, standard-1/],
    [{ egress: [{ host: "GitHub.com" }] }, /public DNS name/],
    [{ egress: [{ host: "github.com:443" }] }, /public DNS name/],
    [{ egress: [{ host: "*.github.com" }] }, /public DNS name/],
    [{ egress: [{ host: "10.0.0.1" }] }, /public DNS name/],
    [{ egress: [{ host: "metadata.internal" }] }, /public DNS name/],
    [{ egress: [{ host: "localhost" }] }, /public DNS name/],
    [{ egress: [{ host: "github.com" }, { host: "github.com" }] }, /listed twice/],
    [{ egress: [{ host: "github.com", scheme: "basic" }] }, /scheme needs auth/],
    [{ egress: [{ host: "github.com", auth: { type: "bearer", token: "x" } }] }, /type: "exchange"/],
    [{ egress: [{ host: "github.com", auth: { ...exchange, url: "http://app.example.net/token" } }] }, /auth.url: Only https/],
    [{ egress: [{ host: "github.com", auth: { ...exchange, audience: "https://other.example.org" } }] }, /audience/],
    [{ egress: Array.from({ length: 33 }, (_, i) => ({ host: `h${i}.example.net` })) }, /at most 32/],
  ] as const) assert.throws(() => computerSettingsInput(value, check, "acme"), message as RegExp);
});

test("computer settings: a github-app grant names one of the tenant's Apps, is for GitHub's hosts, and defaults to git's Basic on github.com", () => {
  const app = { type: "github-app", app: "code", repositories: ["Acme/App"], permissions: { pull_requests: "write", contents: "write" } };
  assert.deepEqual(computerSettingsInput({ egress: [{ host: "github.com", auth: app }, { host: "api.github.com", auth: { type: "github-app", app: "code", owner: "acme" } }] }, check, "acme").egress, [
    { host: "github.com", auth: { type: "github-app", app: "code", repositories: ["acme/app"], permissions: { contents: "write", pull_requests: "write" } }, scheme: "basic" },
    { host: "api.github.com", auth: { type: "github-app", app: "code", owner: "acme" }, scheme: "bearer" },
  ]);
  assert.equal(computerSettingsInput({ egress: [{ host: "github.com", auth: app, scheme: "bearer" }] }, check, "acme").egress![0].scheme, "bearer");
  for (const [value, message] of [
    [{ egress: [{ host: "registry.npmjs.org", auth: app }] }, /auth github-app is for GitHub's hosts: github\.com, api\.github\.com/],
    [{ egress: [{ host: "github.com", auth: { type: "github-app" } }] }, /computer\.egress\[0\]\.auth\.app is the name or id/],
    [{ egress: [{ host: "github.com", auth: { ...app, url: "https://x.example.net" } }] }, /Unrecognized key: "url"/],
    [{ egress: [{ host: "github.com", auth: { ...app, repositories: ["acme/a", "other/b"] } }] }, /must all have one owner/],
  ] as const) assert.throws(() => computerSettingsInput(value, check, "acme"), message as RegExp);
});

test("a github-app grant's token is dropped only when GitHub answers 401: a 403 is what the scoped token may not do", async () => {
  const grant: EgressGrant = { host: "github.com", auth: { type: "github-app", app: "code", repositories: ["acme/app"] }, scheme: "basic" };
  const dropped: string[] = [];
  const tokens = ["ghs_one", "ghs_two"];
  const credential = async () => { const token = tokens[0]!; return { token, refused: () => { dropped.push(token); tokens.shift(); } }; };
  const forbidden = upstream([403]);
  const denied = await forwardEgress(new Request("https://github.com/acme/other.git/info/refs?service=git-receive-pack", { headers: { authorization: "Basic bWFjaGluZQ==" } }), grant, { credential, send: forbidden.send });
  assert.equal(denied.status, 403);
  assert.deepEqual([forbidden.seen.length, dropped], [1, []], "not retried, and the token is kept");
  assert.equal(forbidden.seen[0].headers.get("authorization"), `Basic ${btoa("x-access-token:ghs_one")}`, "the machine's own Authorization never reaches GitHub");
  const expired = upstream([401, 200]);
  assert.equal((await forwardEgress(new Request("https://github.com/acme/app.git/info/refs"), grant, { credential, send: expired.send })).status, 200);
  assert.deepEqual(dropped, ["ghs_one"]);
  assert.deepEqual(expired.seen.map(request => request.headers.get("authorization")), [`Basic ${btoa("x-access-token:ghs_one")}`, `Basic ${btoa("x-access-token:ghs_two")}`]);
  const failed = await forwardEgress(new Request("https://github.com/acme/app.git/info/refs"), grant, { credential: async () => { throw new Error("GitHub App code is not one of this tenant's"); }, send: expired.send });
  assert.equal(failed.status, 502);
  assert.match((await failed.json() as { error: string }).error, /camelRun egress credential for github\.com: GitHub App code is not one of this tenant's/);
});

test("the tool tells the model it has the Internet and which hosts the runtime authenticates", () => {
  assert.equal(egressDescription(undefined), "Internet access.");
  const text = egressDescription({ egress: [{ host: "github.com", auth: exchange, scheme: "basic" }, { host: "registry.npmjs.org" }] });
  assert.match(text, /^Internet access\. Requests to github\.com are authenticated by the runtime/);
  assert.doesNotMatch(text, /registry\.npmjs\.org/);
});

function upstream(statuses: number[] = [200]) {
  const seen: Request[] = [];
  return {
    seen,
    async send(request: Request) {
      seen.push(request);
      return new Response(`upstream ${seen.length}`, { status: statuses[seen.length - 1] ?? 200 });
    },
  };
}

test("an authenticated grant replaces the machine's Authorization with the runtime's credential", async () => {
  const grant: EgressGrant = { host: "github.com", auth: exchange, scheme: "basic" };
  const up = upstream();
  const response = await forwardEgress(new Request("https://github.com/acme/app.git/info/refs?service=git-upload-pack", {
    headers: { authorization: "Bearer stolen-or-placeholder", "user-agent": "git/2.47" },
  }), grant, { credential: async () => ({ token: "ghs_live", refused() {} }), send: up.send });
  assert.equal(response.status, 200);
  assert.equal(up.seen[0].url, "https://github.com/acme/app.git/info/refs?service=git-upload-pack");
  assert.equal(up.seen[0].headers.get("authorization"), `Basic ${btoa("x-access-token:ghs_live")}`);
  assert.equal(up.seen[0].headers.get("user-agent"), "git/2.47");
  assert.equal(up.seen[0].redirect, "manual");

  const bearer = upstream();
  await forwardEgress(new Request("https://api.github.com/repos/acme/app/pulls", { method: "POST", body: "{}", headers: { authorization: "token placeholder" } }),
    { host: "api.github.com", auth: exchange, scheme: "bearer" }, { credential: async () => ({ token: "ghs_live", refused() {} }), send: bearer.send });
  assert.equal(bearer.seen[0].headers.get("authorization"), "Bearer ghs_live");
  assert.equal(await bearer.seen[0].text(), "{}");
});

test("a grant without auth passes the request through; a request for another host is refused", async () => {
  const up = upstream();
  await forwardEgress(new Request("https://registry.npmjs.org/left-pad", { headers: { authorization: "Bearer npm_own" } }), { host: "registry.npmjs.org" },
    { credential: async () => { throw new Error("no credential for an open grant"); }, send: up.send });
  assert.equal(up.seen[0].headers.get("authorization"), "Bearer npm_own");
  const wrong = await forwardEgress(new Request("https://evil.example.net/"), { host: "registry.npmjs.org" }, { credential: async () => ({ token: "x", refused() {} }), send: up.send });
  assert.equal(wrong.status, 403);
  assert.equal(up.seen.length, 1);
});

test("a refused credential is dropped; a bodiless request is sent once more with a fresh one", async () => {
  const tokens = ["old", "new"], dropped: string[] = [];
  const credential = async () => { const token = tokens.shift()!; return { token, refused: () => dropped.push(token) }; };
  const up = upstream([401, 200]);
  const response = await forwardEgress(new Request("https://api.github.com/user"), { host: "api.github.com", auth: exchange, scheme: "bearer" }, { credential, send: up.send });
  assert.equal(response.status, 200);
  assert.deepEqual(dropped, ["old"]);
  assert.deepEqual(up.seen.map(r => r.headers.get("authorization")), ["Bearer old", "Bearer new"]);

  // A request with a body cannot be replayed: its refusal goes back to the machine, and the next request gets a new credential.
  const once = upstream([403]), pushed: string[] = [];
  const refused = await forwardEgress(new Request("https://github.com/acme/app.git/git-receive-pack", { method: "POST", body: "pack" }), { host: "github.com", auth: exchange, scheme: "basic" },
    { credential: async () => ({ token: "t", refused: () => pushed.push("t") }), send: once.send });
  assert.equal(refused.status, 403);
  assert.equal(once.seen.length, 1);
  assert.deepEqual(pushed, ["t"]);
});

test("an exchange failure answers 502 without calling the host", async () => {
  const up = upstream();
  const response = await forwardEgress(new Request("https://github.com/acme/app.git/info/refs"), { host: "github.com", auth: exchange, scheme: "basic" },
    { credential: async () => { throw new Error("app.example.net answered HTTP 403: not this repo"); }, send: up.send });
  assert.equal(response.status, 502);
  assert.match((await response.json() as { error: string }).error, /not this repo/);
  assert.equal(up.seen.length, 0);
});

test("TEST_MODE's loopback upstream keeps the path and names the granted host", async () => {
  const up = upstream();
  await forwardEgress(new Request("https://github.com/acme/app.git/info/refs?service=git-receive-pack"), { host: "github.com" },
    { credential: async () => ({ token: "x", refused() {} }), send: up.send, testUpstream: new URL("http://127.0.0.1:9999") });
  assert.equal(up.seen[0].url, "http://127.0.0.1:9999/acme/app.git/info/refs?service=git-receive-pack");
  assert.equal(up.seen[0].headers.get("x-camelrun-egress-host"), "github.com");
});

function container() {
  const calls: unknown[][] = [];
  const store = new Map<string, unknown>();
  const box = {
    running: false,
    images: { workspace: "img" },
    start(options: unknown) { calls.push(["start", options]); this.running = true; },
    async destroy() { calls.push(["destroy"]); this.running = false; },
    async setInactivityTimeout(ms: number) { calls.push(["idle", ms]); },
    async interceptOutboundHttps(host: string) { calls.push(["intercept", host]); },
    async snapshotContainer() { return { id: "snap" }; },
    async exec(argv: string[], options?: { env?: Record<string, string> }) {
      calls.push(["exec", argv, options?.env]);
      const empty = () => new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
      return { stdout: empty(), stderr: empty(), exitCode: Promise.resolve(0), kill() {} };
    },
  };
  return {
    calls,
    box,
    store: { async get<T>(key: string) { return store.get(key) as T | undefined; }, async put(key: string, value: unknown) { store.set(key, value); } },
  };
}

test("a computer with grants starts online, intercepts each granted host and trusts the interception CA", async () => {
  const { calls, box, store } = container();
  const gateway = {} as Fetcher;
  const network: ComputerNetwork = { key: "k1", egress: [{ grant: { host: "github.com" }, gateway }, { grant: { host: "registry.npmjs.org" }, gateway }], idleMs: 900_000 };
  await operate(new ContainerProvider(box as never, store, undefined, Date.now, network), { op: "exec", argv: ["true"] });
  const start = calls.find(call => call[0] === "start")![1] as { enableInternet: boolean; env: Record<string, string> };
  assert.equal(start.enableInternet, true);
  assert.equal(start.env.NODE_EXTRA_CA_CERTS, CONTAINER_CA);
  assert.deepEqual(calls.filter(call => call[0] === "intercept").map(call => call[1]), ["github.com", "registry.npmjs.org"]);
  assert.ok(calls.some(call => call[0] === "exec" && (call[1] as string[]).join(" ").includes("update-ca-certificates")));
  assert.deepEqual(calls.find(call => call[0] === "idle"), ["idle", 900_000]);
  // exec does not inherit start()'s env: the model's command gets the CA trust (npm failed SELF_SIGNED_CERT_IN_CHAIN).
  const command = calls.filter(call => call[0] === "exec").at(-1)!;
  assert.deepEqual(command[1], ["true"]);
  assert.equal((command[2] as Record<string, string>).NODE_EXTRA_CA_CERTS, CONTAINER_CA);
  assert.equal((command[2] as Record<string, string>).PIP_CERT, "/etc/ssl/certs/ca-certificates.crt");

  // The same grants reuse the running machine; changed grants replace it.
  calls.length = 0;
  await operate(new ContainerProvider(box as never, store, undefined, Date.now, network), { op: "exec", argv: ["true"] });
  assert.equal(calls.some(call => call[0] === "destroy" || call[0] === "start"), false);
  await operate(new ContainerProvider(box as never, store, undefined, Date.now, { ...network, key: "k2", egress: [network.egress[0]] }), { op: "exec", argv: ["true"] });
  assert.deepEqual(calls.filter(call => ["destroy", "start", "intercept"].includes(call[0] as string)).map(call => call[0] === "intercept" ? call[1] : call[0]), ["destroy", "start", "github.com"]);
});

test("a computer without grants starts online and trusts no CA", async () => {
  const { calls, box, store } = container();
  await operate(new ContainerProvider(box as never, store), { op: "exec", argv: ["true"] });
  const start = calls.find(call => call[0] === "start")![1] as Record<string, unknown>;
  assert.deepEqual(start, { image: "img", instance: "lite", enableInternet: true });
  assert.deepEqual(calls.find(call => call[0] === "exec")![1], ["mkdir", "-p", "/workspace"]);
  // Without grants nothing is intercepted, so no CA is trusted.
  assert.equal(calls.some(call => call[0] === "exec" && (call[1] as string[]).join(" ").includes("update-ca-certificates")), false);
  assert.deepEqual(calls.find(call => call[0] === "idle"), ["idle", 60_000]);
  assert.equal(calls.filter(call => call[0] === "exec").at(-1)![2], undefined, "no grants, no CA environment");
});

test("a forked child boots from the parent's snapshot (its seed), with this computer's grants", async () => {
  const { calls, box, store } = container();
  const network: ComputerNetwork = { key: "child", egress: [{ grant: { host: "github.com" }, gateway: {} as Fetcher }], idleMs: 60_000 };
  const handle = { id: "parent-snap", name: "fork-a", size: 1, image: "img", createdAt: Date.now(), expiresAt: Date.now() + 86_400_000 };
  const child = new ContainerProvider(box as never, store, undefined, Date.now, network);
  await child.seed(handle, { parent: "parent-computer", agent: "parent", batch: "run:m1", at: Date.now() });
  const result = await operate(child, { op: "exec", argv: ["true"] }) as Record<string, any>;
  assert.equal(result.computer.restoredFrom, "fork");
  const start = calls.find(call => call[0] === "start")![1] as Record<string, unknown>;
  assert.deepEqual(start.containerSnapshot, { id: "parent-snap" });
  assert.equal(start.enableInternet, true);
  assert.deepEqual(calls.filter(call => call[0] === "intercept").map(call => call[1]), ["github.com"]);
  // The snapshot's machine trusted its own CA; this machine's is trusted again.
  assert.ok(calls.some(call => call[0] === "exec" && (call[1] as string[]).join(" ").includes("update-ca-certificates")));
});

test("exec takes a shell command, run with bash -lc, as well as an argv list", async () => {
  const { calls, box, store } = container();
  await operate(new ContainerProvider(box as never, store), { op: "exec", command: "cd /workspace && git status | head -3" });
  assert.deepEqual(calls.filter(call => call[0] === "exec").at(-1)![1], ["bash", "-lc", "cd /workspace && git status | head -3"]);
  await assert.rejects(operate(new ContainerProvider(box as never, store), { op: "exec", command: "" }), /Invalid command/);
  await assert.rejects(operate(new ContainerProvider(box as never, store), { op: "exec", command: "true", argv: ["true"] } as never), /command or argv/);
});

test("a definition's instance size starts the machine at that size, and a new size replaces a running one", async () => {
  const { calls, box, store } = container();
  const at = (instance: "standard-2" | "standard-4") => new ContainerProvider(box as never, store, { image: "workspace", instance }, Date.now,
    { key: JSON.stringify([[], null, instance]), egress: [], idleMs: 60_000 });
  await operate(at("standard-2"), { op: "exec", command: "true" });
  assert.equal((calls.find(call => call[0] === "start")![1] as { instance: string }).instance, "standard-2");
  calls.length = 0;
  await operate(at("standard-4"), { op: "exec", command: "true" });
  assert.deepEqual(calls.filter(call => call[0] === "destroy" || call[0] === "start").map(call => call[0] === "start" ? (call[1] as { instance: string }).instance : call[0]), ["destroy", "standard-4"]);
});

test("the parent-link cache stays bounded, dropping the oldest entries", async () => {
  const { rememberParent, parentCacheSize, PARENT_CACHE_ENTRIES } = await import("../src/computers/agent-setup.ts");
  for (let i = 0; i < PARENT_CACHE_ENTRIES + 50; i++) rememberParent(`client_${i}`, i % 2 ? `parent_${i}` : null);
  assert.equal(parentCacheSize(), PARENT_CACHE_ENTRIES);
});

test("limited gateway checks the destination even for an authenticated grant and never follows redirects", async () => {
  const { networkingInput } = await import("../../../src/core/vault.ts");
  const network = networkingInput({type:"limited",allowedHosts:["api.stripe.com"]});
  let sent = 0;
  const deps = { networking: network, credential: async () => ({token:"live-secret",refused(){}}), send: async (request: Request) => {
    sent++; assert.equal(request.redirect,"manual"); assert.equal(new URL(request.url).host,"api.stripe.com");
    return new Response("live-secret",{status:302,headers:{location:"https://evil.com/?key=live-secret"}});
  }};
  assert.equal((await forwardEgress(new Request("https://evil.com"),{host:"*"},deps)).status,403);
  assert.equal(sent,0);
  const response=await forwardEgress(new Request("https://api.stripe.com//evil.com/path"),{host:"api.stripe.com",auth:{type:"vault",name:"TOKEN"}},deps);
  assert.equal(sent,1); assert.equal(response.status,302);
  assert.equal(await response.text(),"[hidden]"); assert.equal(response.headers.get("location"),"https://evil.com/?key=[hidden]");
});

test('GitHub packfiles and header-only request streams bypass the vault and masking',async()=>{
  const bytes=new Uint8Array([80,65,67,75,0,255,0,1]);
  const pack=new Response(bytes,{headers:{'content-type':'application/x-git-upload-pack-result',etag:'"pack"','content-length':String(bytes.length)}});
  let touched=0;
  const body=new Uint8Array(8*1024*1024+1);
  const response=await forwardEgress(new Request('https://github.com/repo.git/git-upload-pack',{method:'POST',body}),{host:'github.com',auth:{type:'github-app',app:'code'}},{
    vault:{service:async()=>{touched++;throw Error('no vault');},tenant:'t',refs:[]},
    credential:async()=>({token:'ghs_no_mask_for_git',refused(){}}),send:async request=>{assert.equal((await request.arrayBuffer()).byteLength,body.length);return pack;}
  });
  assert.equal(response,pack);assert.equal(touched,0);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);assert.equal(response.headers.get('etag'),'"pack"');
});

test('body opt-in returns 413 and malformed encoding returns 400, without an upstream request',async()=>{
  let sends=0;
  const deps={vault:{service:async()=>{throw Error('unused');},tenant:'t',refs:[{type:'vault' as const,name:'TOKEN',inBody:true}]},credential:async()=>({token:'unused-long-token',refused(){}}),send:async()=>{sends++;return new Response('unexpected');}};
  const oversized=await forwardEgress(new Request('https://example.com',{method:'POST',body:new Uint8Array(8*1024*1024+1)}),{host:'*'},deps);
  assert.equal(oversized.status,413);assert.match(await oversized.text(),/Vault request body exceeds 8 MiB/);
  const malformed=await forwardEgress(new Request('https://example.com/%zz',{headers:{authorization:'camel-vault-TOKEN-placeholder'}}),{host:'*'},deps);
  assert.equal(malformed.status,400);assert.equal(sends,0);
});

test('exact dispatch wins over the wildcard and an empty MCP host list preserves the network key',async()=>{
  const {selectEgressGrant,computerNetworkKey}=await import('../src/computers/egress.ts');
  const exact={host:'github.com',auth:{type:'github-app' as const,app:'code'}},fallback={host:'*'};
  for(const grants of [[exact,fallback],[fallback,exact]]) assert.equal(selectEgressGrant('github.com',fallback,grants),exact);
  assert.equal(selectEgressGrant('evil.com',fallback,[exact]),fallback);
  const key=computerNetworkKey([exact],{tenant:'t'},{egress:[exact]});
  assert.equal(key,JSON.stringify([[exact],{tenant:'t'},null]));
  assert.equal(computerNetworkKey([exact],{tenant:'t'},{egress:[exact],mcpHosts:[]}),key);
  const {calls,box,store}=container();
  await operate(new ContainerProvider(box as never,store,undefined,Date.now,{key,egress:[],idleMs:60000}),{op:'exec',argv:['true']});
  calls.length=0;
  await operate(new ContainerProvider(box as never,store,undefined,Date.now,{key:computerNetworkKey([exact],{tenant:'t'},{mcpHosts:[]}),egress:[],idleMs:60000}),{op:'exec',argv:['true']});
  assert.equal(calls.some(c=>c[0]==='start'||c[0]==='destroy'),false);
});

test('malformed percent encoding passes through non-vault requests but vault grants reject it',async()=>{
  let sent=0;
  const deps={vault:{service:async()=>{throw Error('must stay lazy');},tenant:'t',refs:[]},credential:async()=>({token:'github-token',refused(){}}),send:async(request:Request)=>{sent++;assert.equal(new URL(request.url).search,'?q=100%');return new Response('ok');}};
  const input=()=>new Request('https://github.com/search?q=100%');
  assert.equal((await forwardEgress(input(),{host:'github.com',auth:{type:'github-app',app:'code'}},deps)).status,200);
  assert.equal((await forwardEgress(input(),{host:'github.com',auth:{type:'vault',name:'TOKEN'}},deps)).status,400);
  assert.equal(sent,1);
});

test('vault substitutions mask untyped, octet-stream and JavaScript echoes, while GitHub grants skip masking',async()=>{
  for (const type of [undefined,'application/octet-stream','application/javascript']) {
    const deps={credential:async()=>({token:'vault-secret',refused(){}}),send:async()=>new Response(new TextEncoder().encode('vault-secret'),{headers:type?{'content-type':type}:{}})};
    const response=await forwardEgress(new Request('https://api.example.com'),{host:'api.example.com',auth:{type:'vault',name:'TOKEN'}},deps);
    assert.equal(await response.text(),'[hidden]');
  }
  const response=await forwardEgress(new Request('https://github.com/search'),{host:'github.com',auth:{type:'github-app',app:'code'}},{credential:async()=>({token:'github-token',refused(){}}),send:async()=>new Response('github-token',{headers:{etag:'original'}})});
  assert.equal(await response.text(),'github-token');assert.equal(response.headers.get('etag'),'original');
});
