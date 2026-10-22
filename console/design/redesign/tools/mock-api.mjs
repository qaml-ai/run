// A fixture API for running the console locally (vite proxies /v1 and /console/auth here).
import { createServer } from "node:http";

const now = Date.now(), day = 86_400_000;
const ws = [
  { id: "ws_support", name: "Support bot", archived: false, createdAt: now - 20 * day, updatedAt: now - 20 * day },
  { id: "ws_research", name: "Research", archived: false, createdAt: now - 12 * day, updatedAt: now - 12 * day },
  { id: "ws_old", name: "Hackathon", archived: true, createdAt: now - 60 * day, updatedAt: now - 30 * day },
];
const agents = [
  { id: "ag_1", name: "support-acme-4411", type: "agent", model: "anthropic/claude-sonnet-5.5", connected: true, running: true, expiresAt: null, key: "acme-4411" },
  { id: "ag_2", name: "support-globex-0921", type: "agent", model: "anthropic/claude-sonnet-5.5", connected: false, running: false, expiresAt: now + day, key: "globex-0921" },
  { id: "ag_3", name: "researcher", type: "agent", model: "openai/gpt-5.5", connected: false, running: false, expiresAt: null, key: "researcher" },
  { id: "ag_4", name: "researcher / web pass", type: "agent", model: "openai/gpt-5.5-mini", connected: false, running: true, expiresAt: now + day, parentAgentId: "ag_3" },
  { id: "ag_5", name: "Playground", type: "agent", model: "anthropic/claude-sonnet-5.5", connected: false, running: false, expiresAt: null, key: "playground" },
  { id: "ag_6", name: "nightly-digest", type: "agent", model: "deepseek/deepseek-v4", connected: false, running: false, expiresAt: null, key: "digest" },
];
const memberships = [
  { kind: "agent", id: "ag_1", workspaceId: "ws_support" }, { kind: "agent", id: "ag_2", workspaceId: "ws_support" },
  { kind: "agent", id: "ag_3", workspaceId: "ws_research" }, { kind: "agent", id: "ag_4", workspaceId: "ws_research" },
  { kind: "definition", id: "def_support", workspaceId: "ws_support" },
];
const definitions = [
  { id: "def_support", name: "Support agent", revision: 7, model: "anthropic/claude-sonnet-5.5", createdAt: now - 20 * day, updatedAt: now - 2 * day, builtins: ["web_search"] },
  { id: "def_research", name: "Researcher", revision: 3, model: "openai/gpt-5.5", createdAt: now - 12 * day, updatedAt: now - 5 * day, builtins: ["web_fetch", "delegate"] },
];
const models = ["anthropic/claude-sonnet-5.5", "openai/gpt-5.5", "deepseek/deepseek-v4"];
const days = [];
for (let i = 13; i >= 0; i--) {
  const d = new Date(now - i * day).toISOString().slice(0, 10);
  models.forEach((model, m) => days.push({ day: d, model, kind: "turn", responses: 40 + m * 13 + i * 3, input: 120000 + i * 9000, output: 18000 + m * 900, cacheRead: 300000, cacheWrite: 20000, cost: +(1.2 + m * 0.7 + i * 0.05).toFixed(4), platformCost: 0 }));
}
const sum = rows => rows.reduce((t, r) => ({ responses: t.responses + r.responses, input: t.input + r.input, output: t.output + r.output, cacheRead: t.cacheRead + r.cacheRead, cacheWrite: t.cacheWrite + r.cacheWrite, cost: t.cost + r.cost }), { responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const usage = filter => {
  const share = filter === "ws_support" ? 0.55 : filter === "ws_research" ? 0.3 : filter === "unassigned" ? 0.15 : 1;
  const rows = days.map(r => ({ ...r, responses: Math.round(r.responses * share), cost: r.cost * share }));
  const totals = sum(days);
  return { since: now - 30 * day, totals: sum(rows), days: rows, workspaces: [
    { id: "ws_support", name: "Support bot", responses: Math.round(totals.responses * .55), cost: totals.cost * .55 },
    { id: "ws_research", name: "Research", responses: Math.round(totals.responses * .3), cost: totals.cost * .3 },
    { id: null, name: "Unassigned", responses: Math.round(totals.responses * .15), cost: totals.cost * .15 },
  ] };
};
const billing = {
  billing: "prepaid", balance: 48_120_000, purchased: 100_000_000, freeCredit: false, checkout: true,
  busyAgents: { busy: 2, limit: 20, source: "tier", tier: "Tier 2", paid: 100_000_000, next: { tier: "Tier 3", paid: 500_000_000, limit: 50 } },
  runsPerMinute: { limit: 600 }, startingCredit: { status: "granted", amount: 5_000_000 },
  month: { since: now - 21 * day, grant: 5e6, purchase: 1e8, usage: -51e6, storage: -1.2e6, adjustment: 0, refund: 0 },
  recent: [{ id: 1, kind: "usage", amount: -2_310_000, metadata: {}, createdAt: now - day }, { id: 2, kind: "purchase", amount: 50_000_000, metadata: {}, createdAt: now - 5 * day }],
  rates: { agentHour: 20000, storageGbMonth: 100000, purchaseFeeBps: 300, minPurchase: 5e6, maxPurchase: 5e9, webSearch: { exa: 5000 }, webRender: 1000 },
};
const routes = {
  "/v1/me": { tenant: "acme-labs", via: "console", login: "miguel@camelqa.com", name: "Miguel", signIn: "google", canStoreKeys: true },
  "/v1/billing": billing,
  "/v1/billing/alerts": { threshold: 10_000_000, emailEnabled: true, recipients: [] },
  "/v1/billing/auto-topup": { enabled: true, state: "on", version: 1, threshold: 10e6, amount: 50e6, fee: 1.5e6, total: 51.5e6, monthlyLimit: 500e6, usedThisPeriod: 0, held: 0, resetsAt: now + 9 * day, attempt: null },
  "/v1/billing/payment-method": { portal: true, customer: true, card: { brand: "visa", last4: "4242", expMonth: 4, expYear: 2029 } },
  "/v1/billing/ledger": billing.recent,
  "/v1/agents": agents,
  "/v1/tokens": [{ id: "tok_1", name: "production", prefix: "cr_live_8f2a", createdAt: now - 20 * day }, { id: "tok_2", name: "laptop", prefix: "cr_live_19bc", createdAt: now - 3 * day }],
  "/v1/oauth/grants": [],
  "/v1/definitions": definitions,
  "/v1/workspaces": ws,
  "/v1/workspace-memberships": memberships,
  "/v1/channels": [{ id: "ch_1", type: "slack", name: "Acme support Slack", definition: "def_support", access: { public: false, allow: [] }, limits: { perSenderPerMinute: 10, turnsPerDay: 500 }, account: { team: "Acme" }, credentials: {}, createdAt: now - 15 * day }],
  "/v1/volumes": [{ id: "vol_kb", name: "support-kb", createdAt: now - 18 * day }, { id: "vol_papers", name: "papers", createdAt: now - 10 * day }],
  "/v1/providers": [
    { id: "anthropic", kind: "model", models: 12, apiKey: true, key: { provider: "anthropic", source: "tenant", last4: "a9Qe", setAt: now - 20 * day } },
    { id: "openai", kind: "model", models: 30, apiKey: true, key: { provider: "openai", source: "platform" } },
    { id: "deepseek", kind: "model", models: 4, apiKey: true, key: null },
    { id: "exa", kind: "search", models: 0, apiKey: true, key: { provider: "exa", source: "platform" } },
  ],
  "/v1/models": models.map(id => ({ id, provider: id.split("/")[0], modelId: id.split("/")[1], name: id, api: "x", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 64000, cost: { input: 3, output: 15, cacheRead: .3, cacheWrite: 3.75 }, available: true, toolCallStreaming: true })),
  "/console/discord/config": { enabled: true },
  "/console/discord/bindings": { bindings: [] },
};
const detail = id => ({ ...agents.find(a => a.id === id), tools: [], toolSources: [], systemPrompt: "You are Acme's support agent.", requests: [
  { id: "req_1", method: "prompt", state: "completed", startedAt: now - 3600e3, endedAt: now - 3590e3, prompt: "Where is my order #4411?", outcome: { result: "done" } },
  { id: "req_2", method: "prompt", state: "completed", startedAt: now - 7200e3, endedAt: now - 7100e3, prompt: "Refund request", outcome: { error: "Model call failed: 529 overloaded" } },
], mounts: [{ volumeId: "vol_kb", path: "/kb", mode: "ro" }], definition: { id: "def_support", revision: 7 } });

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let body = routes[url.pathname];
  if (url.pathname === "/v1/usage") body = usage(url.searchParams.get("workspaceId") ?? undefined);
  else if (/^\/v1\/agents\/[^/]+$/.test(url.pathname)) body = detail(url.pathname.split("/")[3]);
  else if (/^\/v1\/agents\/[^/]+\/history$/.test(url.pathname)) body = { messages: [{ role: "user", content: "Where is my order #4411?" }, { role: "assistant", content: [{ type: "text", text: "It shipped yesterday; tracking 1Z999." }] }] };
  else if (/^\/v1\/agents\/[^/]+\/schedules$/.test(url.pathname) || /schedule-deliveries$/.test(url.pathname)) body = [];
  else if (/^\/v1\/workspaces\/[^/]+\/members$/.test(url.pathname)) body = memberships.filter(m => m.workspaceId === url.pathname.split("/")[3]).map(({ kind, id }) => ({ kind, id }));
  else if (url.pathname === "/v1/telemetry") { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "No telemetry export" })); }
  if (body === undefined) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: `mock: ${url.pathname}` })); }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}).listen(8790, "127.0.0.1", () => console.log("mock api on 8790"));
