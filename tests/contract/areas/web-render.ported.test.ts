import {portedTest} from "../ported.ts";
const test = portedTest("search", "tests/web-render.test.ts");
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {free,listen,runtime,toolCall,toolResults,until,type T} from "../support.ts";

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

const SHELL = `<!doctype html><html><head><title>App</title><script>${"window.x=1;".repeat(600)}</script></head><body><div id="root"></div></body></html>`;

const ARTICLE = `<!doctype html><html><head><title>Article</title></head><body><h1>Article</h1><p>${"Plain server-rendered prose. ".repeat(40)}</p></body></html>`;

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
  const r = await runtime(t, free((body: any) => {
    const step = body.messages.filter((message: any) => message.role === "tool").length;
    return fetches[step] ? toolCall("web_fetch", { url: fetches[step] }, `fetch_${step}`) : { role: "assistant", content: "done" };
  }), {
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
