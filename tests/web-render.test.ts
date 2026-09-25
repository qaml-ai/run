import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { UsageRecord } from "../src/client-sessions.ts";
import { Outbound } from "../src/outbound.ts";
import { isShell, WebRender } from "../src/web-render.ts";
import { listen, runtime, toolCall, toolResults, until, type T } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PAYG = "payg-operator-token-at-least-24-chars";
const OPS = "ops-operator-token-at-least-24-chars";
const tenantsFile = {
  tenants: {
    payg: { tokenSha256: sha(PAYG), apiKeys: {}, billing: "prepaid" },
    ops: { tokenSha256: sha(OPS), apiKeys: { openrouter: "fixture-model-key" } },
  },
  platformKeys: { openrouter: "fixture-platform-model-key", firecrawl: "platform-firecrawl-key" },
};
/** A single-page app: kilobytes of script, an empty mount point, and no text until the script runs. */
const SHELL = `<!doctype html><html><head><title>App</title><script>${"window.x=1;".repeat(600)}</script></head><body><div id="root"></div></body></html>`;
const ARTICLE = `<!doctype html><html><head><title>Article</title></head><body><h1>Article</h1><p>${"Plain server-rendered prose. ".repeat(40)}</p></body></html>`;

test("a page is a shell when a script draws its content: much HTML and next to no text, or a bare mount point", () => {
  assert.equal(isShell(SHELL, "App"), true);
  assert.equal(isShell(`<html><body><div id="app"></div><p>Loading…</p></body></html>`, "Loading…"), true, "a small page with an empty mount point");
  assert.equal(isShell(`<html><body><noscript>You need to enable JavaScript to run this app.</noscript></body></html>`, "You need to enable JavaScript to run this app."), true);
  assert.equal(isShell(ARTICLE, "Article " + "Plain server-rendered prose. ".repeat(40)), false);
  assert.equal(isShell("<html><body><p>Short page.</p></body></html>", "Short page."), false, "short, but nothing suggests a script draws it");
  assert.equal(isShell(`<div id="root"></div>${"<p>Real text here.</p>".repeat(100)}`, "Real text here. ".repeat(100)), false, "server-rendered into its mount point");
});

/** Firecrawl's scrape endpoint, recording each request: it answers with markdown, or from the `failFrom`th request on, HTTP 500. */
async function fakeFirecrawl(t: T) {
  const scrapes: { url: string; key: string }[] = [];
  const state = { failFrom: Infinity };
  const base = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    scrapes.push({ url: body.url, key: String(req.headers.authorization) });
    if (scrapes.length >= state.failFrom) return res.writeHead(500, { "Content-Type": "application/json" }).end("{}");
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, data: { markdown: "# Rendered app\n\nWhat the script drew.", metadata: { title: "Rendered app", statusCode: 200 } } }));
  });
  return { url: `${base}/v2/scrape`, scrapes, state };
}

test("web_fetch has Firecrawl render JavaScript shells, and only those, charging a platform render", async t => {
  const firecrawl = await fakeFirecrawl(t);
  const pages = await listen(t, (req, res) => {
    if (req.url === "/app") return res.writeHead(200, { "Content-Type": "text/html" }).end(SHELL);
    if (req.url === "/article") return res.writeHead(200, { "Content-Type": "text/html" }).end(ARTICLE);
    res.writeHead(404).end();
  });
  const fetches = [`${pages}/app`, `${pages}/article`, `${pages}/app`];
  const r = await runtime(t, (body: any) => {
    const step = body.messages.filter((message: any) => message.role === "tool").length;
    return fetches[step] ? toolCall("web_fetch", { url: fetches[step] }, `fetch_${step}`) : { role: "assistant", content: "done" };
  }, {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_FIRECRAWL_SCRAPE_URL: firecrawl.url,
    AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0", AGENT_PRICE_WEB_RENDER_USD: "0.01",
  }, tenantsFile);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  const definition = (await r.call("/v1/definitions", { body: { name: "Reader", builtins: ["web_fetch"] }, token: PAYG })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id }, token: PAYG })).json.id;
  // The third fetch finds Firecrawl failing: the page comes back as fetched, and nothing is charged for it.
  firecrawl.state.failFrom = 2;
  await r.prompt(agent, "read them", PAYG);
  const results = toolResults(r.model.bodies.at(-1)).map((text: string) => JSON.parse(text));
  assert.deepEqual(results[0], { url: `${pages}/app`, status: 200, contentType: "text/markdown", title: "Rendered app", text: "# Rendered app\n\nWhat the script drew.", rendered: true });
  assert.equal(results[1].rendered, undefined, "a page with its text in the HTML is not rendered");
  assert.match(results[1].text, /Plain server-rendered prose/);
  assert.deepEqual([results[2].rendered, results[2].title, results[2].text], [undefined, "App", ""], "Firecrawl failing leaves the page as fetched");
  assert.deepEqual(firecrawl.scrapes, [{ url: `${pages}/app`, key: "Bearer platform-firecrawl-key" }, { url: `${pages}/app`, key: "Bearer platform-firecrawl-key" }]);
  const usage = (await r.call("/v1/usage", { token: PAYG })).json.days.find((day: any) => day.model === "firecrawl/web_fetch");
  assert.deepEqual([usage.responses, usage.platformResponses, usage.platformCost], [1, 1, 0.01]);
  await until(async () => (await r.call("/v1/billing", { token: PAYG })).json.balance === 990_000, "one render's charge");
  const entry = (await r.call("/v1/billing/ledger", { token: PAYG })).json.entries.find((row: any) => row.kind === "usage");
  assert.deepEqual([entry.metadata.renders, entry.metadata.searches], [1, 0]);
});

test("the outbound guard checks a URL before Firecrawl is asked to render it, and without a key nothing is rendered", async t => {
  const firecrawl = await fakeFirecrawl(t);
  const usage: UsageRecord[] = [];
  // intranet.example resolves inside; public.example to the loopback address the test allows.
  const outbound = new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"], resolve: async hostname => [{ address: hostname === "intranet.example" ? "10.0.0.7" : "127.0.0.1", family: 4 }] });
  const keys: Record<string, string> = { firecrawl: "tenant-firecrawl-key" };
  const render = new WebRender({ outbound, endpoint: firecrawl.url, price: 830, key: async (_tenant, provider) => keys[provider] ? { key: keys[provider], platform: false } : undefined, onRender: (_tenant, _agent, record) => usage.push(record) });
  const context = { tenant: "acme", agent: "a1" };
  const signal = new AbortController().signal;
  for (const url of ["http://intranet.example/app", "http://169.254.169.254/latest/meta-data/", "http://10.1.2.3/", "file:///etc/passwd", "http://user:pass@public.example/"]) {
    assert.equal(await render.render(context, url, signal), undefined, url);
  }
  assert.deepEqual(firecrawl.scrapes, [], "Firecrawl never hears of an address the runtime may not reach");
  assert.deepEqual(await render.render(context, "http://public.example/app", signal), { title: "Rendered app", markdown: "# Rendered app\n\nWhat the script drew." });
  assert.deepEqual(firecrawl.scrapes, [{ url: "http://public.example/app", key: "Bearer tenant-firecrawl-key" }]);
  assert.deepEqual(usage, [{ provider: "firecrawl", model: "web_fetch", usage: { cost: { total: 0.00083 } }, platform: false, renders: 1 }]);
  delete keys.firecrawl;
  assert.equal(await render.render(context, "http://public.example/app", signal), undefined);
  assert.equal(firecrawl.scrapes.length, 1, "no key, no render");
});
