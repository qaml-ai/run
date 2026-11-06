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
  assert.deepEqual(computerSettingsInput({ egress: [{ host: "github.com", auth: exchange, scheme: "basic" }, { host: "registry.npmjs.org" }], idleSeconds: 900 }, check, "acme"), {
    egress: [{ host: "github.com", auth: { type: "exchange", url: "https://app.example.net/token" }, scheme: "basic" }, { host: "registry.npmjs.org" }],
    idleSeconds: 900,
  });
  // An exchange grant defaults to a bearer header.
  assert.equal(computerSettingsInput({ egress: [{ host: "api.github.com", auth: exchange }] }, check, "acme").egress![0].scheme, "bearer");
  for (const [value, message] of [
    [[], /must be an object/],
    [{ network: true }, /Unrecognized key: "network"/],
    [{ idleSeconds: 5 }, /idleSeconds must be an integer from 10 to 3600/],
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

test("the tool tells the model which hosts it reaches and that the runtime authenticates them", () => {
  assert.equal(egressDescription(undefined), "No Internet access.");
  const text = egressDescription({ egress: [{ host: "github.com", auth: exchange, scheme: "basic" }, { host: "registry.npmjs.org" }] });
  assert.match(text, /HTTPS access only to github\.com, registry\.npmjs\.org/);
  assert.match(text, /Requests to github\.com are authenticated by the runtime/);
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
    async exec(argv: string[]) {
      calls.push(["exec", argv]);
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

test("a computer with grants starts offline, intercepts each granted host and trusts the interception CA", async () => {
  const { calls, box, store } = container();
  const gateway = {} as Fetcher;
  const network: ComputerNetwork = { key: "k1", egress: [{ grant: { host: "github.com" }, gateway }, { grant: { host: "registry.npmjs.org" }, gateway }], idleMs: 900_000 };
  await operate(new ContainerProvider(box as never, store, undefined, Date.now, network), { op: "exec", argv: ["true"] });
  const start = calls.find(call => call[0] === "start")![1] as { enableInternet: boolean; env: Record<string, string> };
  assert.equal(start.enableInternet, false);
  assert.equal(start.env.NODE_EXTRA_CA_CERTS, CONTAINER_CA);
  assert.deepEqual(calls.filter(call => call[0] === "intercept").map(call => call[1]), ["github.com", "registry.npmjs.org"]);
  assert.ok(calls.some(call => call[0] === "exec" && (call[1] as string[]).join(" ").includes("update-ca-certificates")));
  assert.deepEqual(calls.find(call => call[0] === "idle"), ["idle", 900_000]);

  // The same grants reuse the running machine; changed grants replace it.
  calls.length = 0;
  await operate(new ContainerProvider(box as never, store, undefined, Date.now, network), { op: "exec", argv: ["true"] });
  assert.equal(calls.some(call => call[0] === "destroy" || call[0] === "start"), false);
  await operate(new ContainerProvider(box as never, store, undefined, Date.now, { ...network, key: "k2", egress: [network.egress[0]] }), { op: "exec", argv: ["true"] });
  assert.deepEqual(calls.filter(call => ["destroy", "start", "intercept"].includes(call[0] as string)).map(call => call[0] === "intercept" ? call[1] : call[0]), ["destroy", "start", "github.com"]);
});

test("a computer without grants keeps the original offline start", async () => {
  const { calls, box, store } = container();
  await operate(new ContainerProvider(box as never, store), { op: "exec", argv: ["true"] });
  const start = calls.find(call => call[0] === "start")![1] as Record<string, unknown>;
  assert.deepEqual(start, { image: "img", instance: "lite", enableInternet: false });
  assert.deepEqual(calls.find(call => call[0] === "exec")![1], ["mkdir", "-p", "/workspace"]);
  assert.deepEqual(calls.find(call => call[0] === "idle"), ["idle", 60_000]);
});

test("restore from the parent boots this computer from the parent's snapshot handle, with this computer's grants", async () => {
  const { calls, box, store } = container();
  await assert.rejects(operate(new ContainerProvider(box as never, store), { op: "restore", name: "base", from: "parent" }), /needs the parent's snapshot/);
  // The child's own snapshot of that name is not what a parent restore uses.
  await store.put("snapshot:base", { id: "own" });
  const network: ComputerNetwork = { key: "child", egress: [{ grant: { host: "github.com" }, gateway: {} as Fetcher }], idleMs: 60_000 };
  const handle = { id: "parent-snap", name: "base", size: 1, image: "img", createdAt: Date.now(), expiresAt: Date.now() + 86_400_000 };
  assert.deepEqual(await operate(new ContainerProvider(box as never, store, undefined, Date.now, network), { op: "restore", name: "base", from: "parent" }, undefined, handle),
    { restore: "base", from: "parent" });
  const start = calls.find(call => call[0] === "start")![1] as Record<string, unknown>;
  assert.deepEqual(start.containerSnapshot, { id: "parent-snap" });
  assert.equal(start.enableInternet, false);
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
