import { test } from "node:test";
import assert from "node:assert/strict";
import { Outbound, OutboundBlocked } from "../src/outbound.ts";
import { listen } from "./runtime-server.ts";

const blocked = async (work: () => unknown, pattern?: RegExp) => {
  await assert.rejects(async () => work(), (error: Error) => error instanceof OutboundBlocked && (!pattern || pattern.test(error.message)));
};
const resolveTo = (...addresses: string[]) => async () => addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 }));

test("literal internal addresses are refused in every spelling", async () => {
  const outbound = new Outbound();
  const internal = [
    "https://127.0.0.1/", "https://127.1/", "https://2130706433/", "https://0x7f000001/", "https://017700000001/", "https://0x7f.0.0.1/", "https://0/",
    "https://10.0.0.5/", "https://172.16.0.1/", "https://172.31.255.255/", "https://192.168.1.1/", "https://100.64.0.1/", "https://100.127.255.255/",
    "https://169.254.169.254/latest/meta-data/", "https://169.254.170.2/v2/credentials", "https://[::1]/", "https://[::]/", "https://[fe80::1]/",
    "https://[fd00:ec2::254]/", "https://[fc00::1]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:a9fe:a9fe]/", "https://[64:ff9b::a9fe:a9fe]/",
    "https://[2002:a9fe:a9fe::1]/", "https://224.0.0.1/", "https://255.255.255.255/",
  ];
  for (const url of internal) await blocked(() => outbound.check(url), /private, local or reserved/);
  for (const url of ["https://8.8.8.8/", "https://[2606:4700:4700::1111]/", "https://172.32.0.1/", "https://[::ffff:8.8.8.8]/", "https://example.com/"]) assert.ok(outbound.check(url));
  await blocked(() => outbound.check("http://example.com/"), /Only https/);
  await blocked(() => outbound.check("ftp://example.com/"), /Only https/);
  await blocked(() => outbound.check("file:///etc/passwd"), /Only https/);
  await blocked(() => outbound.check("https://user:pass@example.com/"), /credentials/);
  assert.ok(new Outbound({ allowHttp: true }).check("http://example.com/"));
  // An operator's extra block (the VPC) holds even over an allowed range.
  assert.equal(new Outbound({ allow: ["10.0.0.0/8"] }).blocked("10.1.2.3"), undefined);
  assert.match(new Outbound({ allow: ["10.0.0.0/8"], block: ["10.1.0.0/16"] }).blocked("10.1.2.3")!, /blocked network/);
});

test("names that resolve to an internal address are refused, even among public ones", async () => {
  for (const addresses of [["127.0.0.1"], ["10.0.0.7"], ["169.254.169.254"], ["::1"], ["fd00::1"], ["93.184.216.34", "10.0.0.1"], ["2606:4700::1111", "::ffff:192.168.0.1"]]) {
    const outbound = new Outbound({ resolve: resolveTo(...addresses) });
    await blocked(() => outbound.fetch("https://innocent.example/"), /innocent\.example resolves to/);
    await outbound.dispatcher.close();
  }
  // localhost, through the system resolver.
  await blocked(() => new Outbound({ allowHttp: true }).fetch("http://localhost:65000/"), /localhost resolves to/);
});

test("a connection goes to the address that was checked, so DNS rebinding cannot reach inside", async t => {
  let hits = 0;
  const url = await listen(t, (_req, res) => { hits++; res.writeHead(200, { Connection: "close" }).end("ok"); });
  const port = new URL(url).port;
  let lookups = 0;
  // A rebinding resolver: the allowed address, then the metadata endpoint, and so on.
  const outbound = new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"], resolve: async () => [{ address: lookups++ % 2 ? "169.254.169.254" : "127.0.0.1", family: 4 }] });
  t.after(() => outbound.dispatcher.close());
  const outcomes = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    outcomes.push(await outbound.fetch(`http://rebind.example:${port}/`).then(response => response.text(), error => error instanceof OutboundBlocked ? "blocked" : `error: ${error}`));
  }
  assert.deepEqual(outcomes, ["ok", "blocked", "ok", "blocked", "ok", "blocked"]);
  assert.equal(lookups, 6, "every connection resolved once, and used that answer");
  assert.equal(hits, 3);
});

test("redirects are refused by default, and each followed hop is checked; credentials stay with their origin", async t => {
  const seen: { server: string; authorization?: string; path?: string }[] = [];
  const other = await listen(t, (req, res) => { seen.push({ server: "other", authorization: req.headers.authorization, path: req.url }); res.end("other"); });
  const origin = await listen(t, (req, res) => {
    seen.push({ server: "origin", authorization: req.headers.authorization, path: req.url });
    const to = { "/meta": "http://169.254.169.254/latest/meta-data/", "/private": "http://10.0.0.1/", "/other": `${other}/landed`, "/self": "/final", "/final": undefined }[req.url!];
    if (to) res.writeHead(302, { Location: to }).end(); else res.end("final");
  });
  const outbound = new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] });
  t.after(() => outbound.dispatcher.close());
  const secrets = { Authorization: "Bearer only-for-origin" };
  await blocked(() => outbound.fetch(`${origin}/self`, { secrets }), /Redirects are not followed/);
  await blocked(() => outbound.fetch(`${origin}/meta`, { maxRedirects: 3 }), /169\.254\.169\.254 is a private/);
  await blocked(() => outbound.fetch(`${origin}/private`, { maxRedirects: 3 }), /10\.0\.0\.1 is a private/);
  assert.equal(await (await outbound.fetch(`${origin}/self`, { secrets, maxRedirects: 3 })).text(), "final");
  seen.length = 0;
  assert.equal(await (await outbound.fetch(`${origin}/other`, { secrets, maxRedirects: 3 })).text(), "other");
  assert.deepEqual(seen, [{ server: "origin", authorization: "Bearer only-for-origin", path: "/other" }, { server: "other", authorization: undefined, path: "/landed" }]);
});

test("responses are bounded in time and size", async t => {
  const url = await listen(t, (req, res) => {
    if (req.url === "/slow") return; // never answers
    if (req.url === "/stream") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: 1\n\n"); setTimeout(() => res.end("data: 2\n\n"), 300); return; }
    res.end(Buffer.alloc(64 * 1024, 97));
  });
  const outbound = new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] });
  t.after(() => outbound.dispatcher.close());
  await blocked(() => outbound.fetch(`${url}/slow`, { timeoutMs: 200 }), /No response within 200 ms/);
  await blocked(async () => (await outbound.fetch(`${url}/big`, { maxBytes: 1024 })).text(), /larger than 1024 bytes/);
  assert.equal((await (await outbound.fetch(`${url}/big`, { maxBytes: 64 * 1024 })).text()).length, 64 * 1024);
  // A stream is timed only until it starts.
  assert.equal(await (await outbound.fetch(`${url}/stream`, { timeoutMs: 100, stream: true })).text(), "data: 1\n\ndata: 2\n\n");
  await blocked(async () => (await outbound.fetch(`${url}/stream`, { timeoutMs: 100 })).text(), /No response within 100 ms/);
});
