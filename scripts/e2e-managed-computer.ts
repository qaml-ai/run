// A real agent's whole use of a managed computer, on real Boat: connect, start, commands, upload, download, stop, and
// the charge. The model is scripted (no model key needed); the agent's loop, tools and billing are the runtime's own.
// The machine reaches this runtime for transfers, so it must have a public address.
//
//   BOAT_E2E_KEY_FILE=<a file with the Boat key> BOAT_E2E_URL=https://... PORT=3000 HOST=0.0.0.0 \
//     node --experimental-strip-types --test scripts/e2e-managed-computer.ts
//
// E2E_LONG_SECONDS: how long the long foreground command sleeps (default 620, past Boat's waiting limit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { postLedger } from "../src/billing.ts";
import { micros } from "../src/pricing.ts";
import { runtime, toolCall, until } from "../tests/runtime-server.ts";

const OPERATOR = "e2e-operator-token-at-least-24-characters";
const LONG = Number(process.env.E2E_LONG_SECONDS ?? 620);
const say = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts);

test("an agent starts a managed computer, runs commands, moves files both ways, stops it, and is charged", { timeout: 2400_000 }, async t => {
  const key = readFileSync(process.env.BOAT_E2E_KEY_FILE!, "utf8").trim();
  const steps: [string, Record<string, unknown>][] = [
    ["write", { path: "hello.txt", content: "hello e2e\n" }],
    ["computer_start", {}],
    ["computer_exec", { command: "echo hello from $(uname -s); id -un; python3 --version; git --version; node --version" }],
    ["computer_exec", { command: "nohup setsid sleep 301 >/dev/null 2>&1 & echo started" }],
    ["computer_exec", { command: "pgrep -a sleep || echo gone" }],
    ["computer_exec", { command: "cd ~ && git clone -q --depth 1 https://github.com/expressjs/express && cd express && npm install --silent --no-audit --no-fund && npm test --silent 2>&1 | tail -1" , timeoutSeconds: 300 }],
    ["computer_exec", { command: `x='kept word'; echo "$x %s \${x%% *} $HOME"` }],
    ["computer_upload", { from: "hello.txt", to: "/tmp/hello.txt" }],
    ["computer_exec", { command: "sha256sum /tmp/hello.txt; tr a-z A-Z < /tmp/hello.txt > /tmp/out.txt; cat /tmp/out.txt" }],
    ["computer_download", { from: "/tmp/out.txt", to: "out.txt" }],
    ["read", { path: "out.txt" }],
    ["computer_exec", { command: `sleep ${LONG}; echo slept`, timeoutSeconds: LONG + 60 }],
    ["computer_status", {}],
    ["computer_stop", {}],
  ];
  const seen: { name: string; result: string }[] = [];
  let tools: string[] = [];
  const r = await runtime(t, (body, index) => {
    tools = (body.tools ?? []).map((tool: any) => tool.function.name);
    const last = body.messages.at(-1);
    if (last?.role === "tool") { seen.push({ name: steps[seen.length][0], result: typeof last.content === "string" ? last.content : JSON.stringify(last.content) }); say(steps[seen.length - 1][0], seen.at(-1)!.result.slice(0, 400)); }
    const next = steps[seen.length];
    return next ? toolCall(next[0], next[1], `step_${index}`) : { role: "assistant", content: "done" };
  }, {
    AGENT_MANAGED_COMPUTERS: "on", AGENT_PUBLIC_URL: process.env.BOAT_E2E_URL!, PORT: process.env.PORT ?? "3000", HOST: process.env.HOST ?? "0.0.0.0",
  }, {
    tenants: { acct: { tokenSha256: createHash("sha256").update(OPERATOR).digest("hex"), apiKeys: { openrouter: "fixture-model-key" }, billing: "prepaid" } },
    platformKeys: { boat: key },
  });
  await postLedger(r.db, [{ tenant: "acct", kind: "purchase", amount: micros(5), key: "e2e-fund" }]);
  const call = (path: string, init: Record<string, any> = {}) => r.call(path, { token: OPERATOR, ...init });

  assert.deepEqual((await call("/v1/computers/options")).json, { managed: true });
  const made = await call("/v1/agents", { body: { name: "E2E computer" } });
  assert.equal(made.status, 201, made.text);
  const agent = made.json.id;
  const connected = await call("/v1/computers", { body: { agent, provider: "boat" } });
  assert.equal(connected.status, 201, connected.text);
  assert.deepEqual([connected.json.managed, connected.json.billing, connected.json.leaseSeconds], [true, "credits", 7200]);

  const accepted = await call(`/v1/agents/${agent}/prompt`, { body: { text: "Use your computer." } });
  assert.equal(accepted.status, 202, accepted.text);
  const record = await until(async () => {
    const current = (await call(`/v1/agents/${agent}/requests/${accepted.json.id}`)).json;
    return current.state === "completed" && current;
  }, "the turn to end", 2300_000);
  say("turn", record.state, JSON.stringify(record.stop ?? record.result ?? "").slice(0, 300));
  say("tools the model had", tools.filter(name => name.startsWith("computer")).join(" "));

  const results = Object.fromEntries(seen.map((step, i) => [`${i}:${step.name}`, step.result]));
  assert.equal(seen.length, steps.length, JSON.stringify(results).slice(0, 2000));
  const parsed = seen.map(step => { try { return JSON.parse(step.result); } catch { return step.result; } });
  const by = (name: string, index = 0) => parsed[steps.map((step, i) => [step, i] as const).filter(([step]) => step[0] === name)[index][1]];
  assert.equal(by("computer_start").state, "active");
  assert.match(by("computer_exec", 0).stdout, /hello from Linux/);
  assert.match(by("computer_exec", 2).stdout, /gone/, "a background process ends with its command");
  assert.match(by("computer_exec", 4).stdout, /^kept word %s kept \//, "a command's own $ and % reach its shell");
  assert.equal(by("computer_upload").size, "hello e2e\n".length);
  assert.match(by("computer_exec", 5).stdout, /HELLO E2E/);
  assert.equal(by("computer_download").size, "hello e2e\n".length);
  assert.match(JSON.stringify(by("read")), /HELLO E2E/, "what the computer wrote is in the workspace");
  assert.match(by("computer_exec", 6).stdout, /slept/, "a command past Boat's waiting limit finishes");
  assert.equal(by("computer_stop").stopped, true);

  // The pass runs every 30 s; a stop has already read the cost.
  const usage = (await call("/v1/computers/usage")).json;
  say("usage", JSON.stringify(usage));
  const cost = usage.find((line: any) => line.provider === "boat")?.costUsd;
  assert.ok(cost > 0, "charged");
  await until(async () => (await r.db.query("select 1 from credit_ledger where tenant='acct' and kind='usage' and (metadata->>'computer')::numeric > 0")).rowCount, "the charge in the ledger", 60_000);
  const entry = (await r.db.query("select amount, metadata from credit_ledger where tenant='acct' and kind='usage'")).rows;
  say("ledger", JSON.stringify(entry));
  const days = (await call("/v1/usage?days=1")).json.days?.filter((day: any) => day.kind === "computer");
  say("/v1/usage", JSON.stringify(days));
  assert.ok(days?.length, "a computer row in /v1/usage");
  assert.equal((await r.db.query("select count(*)::int as n from managed_computers where ended_at is null")).rows[0].n, 0);
});
