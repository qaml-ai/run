#!/usr/bin/env node
// One-off, pilot only: before the pilot switches CAMELFS_URL to the camel-fs tier, delete every existing agent and
// repo (they live on RepoDO + the old VPC daemon, whose objects the tier does not have). New agents and repos then
// create their lineages on the tier. Decided by the lead (2026-11-14): start fresh, no backfill, no object copy; the
// pilot has no users (Miguel). RepoDO's leftover data goes with R5.
//
// Usage:
//   node scripts/pilot-tier-reset.mjs --base https://run-pilot.camelai.dev --tenants tenants.json          # dry run
//   node scripts/pilot-tier-reset.mjs --base https://run-pilot.camelai.dev --tenants tenants.json --confirm
// tenants.json: [{ "tenant": "<id>", "token": "<that tenant's API key>" }, ...]  (never commit it)
//
// The dry run prints, per tenant, the agents and repos it would delete (counts and ids) and changes nothing.
// Workflows have no list route: a running workflow whose repos are deleted fails loudly; the dry run says so.
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const base = flag("--base"), file = flag("--tenants"), confirm = args.includes("--confirm");
if (!base || !file) { console.error("usage: --base <pilot origin> --tenants <file.json> [--confirm]"); process.exit(2); }
if (!/^https:\/\/run-pilot\.camelai\.dev\/?$/.test(base) && !args.includes("--not-pilot-i-know")) {
  console.error(`refusing: ${base} is not the pilot (https://run-pilot.camelai.dev)`); process.exit(2);
}
const origin = base.replace(/\/$/, "");
const tenants = JSON.parse(await readFile(file, "utf8"));
if (!Array.isArray(tenants) || tenants.some(t => typeof t?.tenant !== "string" || typeof t?.token !== "string")) {
  console.error("tenants file must be [{ tenant, token }]"); process.exit(2);
}

async function call(token, method, path) {
  const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}` } });
  const text = await response.text();
  if (!response.ok && !(method === "DELETE" && response.status === 404)) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
async function repos(token) {
  const all = [];
  for (let after; ;) {
    const page = await call(token, "GET", `/v1/repos?limit=1000${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    all.push(...page.repos);
    if (!page.next) return all;
    after = page.next;
  }
}

let totals = { agents: 0, repos: 0 };
for (const { tenant, token } of tenants) {
  const agents = (await call(token, "GET", "/v1/agents")).map(a => a.id);
  const repoIds = (await repos(token)).map(r => r.id);
  console.log(`tenant ${tenant}: ${agents.length} agents, ${repoIds.length} repos`);
  for (const id of agents) console.log(`  agent ${id}`);
  for (const id of repoIds) console.log(`  repo  ${id}`);
  totals.agents += agents.length; totals.repos += repoIds.length;
  if (!confirm) continue;
  // Agents first: deleting an agent releases its workspace repo; then whatever repos remain.
  for (const id of agents) await call(token, "DELETE", `/v1/agents/${encodeURIComponent(id)}`);
  for (const id of (await repos(token)).map(r => r.id)) await call(token, "DELETE", `/v1/repos/${encodeURIComponent(id)}`);
  const left = { agents: (await call(token, "GET", "/v1/agents")).length, repos: (await repos(token)).length };
  console.log(`  deleted; remaining: ${left.agents} agents, ${left.repos} repos`);
  if (left.agents || left.repos) { console.error(`tenant ${tenant} is not empty after the reset`); process.exitCode = 1; }
}
console.log(`${confirm ? "deleted" : "would delete"}: ${totals.agents} agents, ${totals.repos} repos across ${tenants.length} tenants`);
if (!confirm) console.log("dry run: nothing changed. Running workflows (no list route) fail loudly once their repos are gone. Re-run with --confirm.");
