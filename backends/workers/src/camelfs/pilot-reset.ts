// TEMPORARY(pilot-switch): one-off, pilot only. Before the pilot switches CAMELFS_URL to the camel-fs tier, delete every
// agent and repo. The old storage objects are discarded at the switch. This runs inside the Worker so no tenant API
// key leaves it. Remove the route after the pilot reset has run.
import { Directory, type ControlEnv } from "../control.ts";
import { withSql } from "../postgres.ts";
import { liveRepos } from "../account-repos.ts";
import { deleteRepo, type RepoEnv } from "../repos/registry.ts";

const PILOT = "https://run-pilot.camelai.dev";
const UNTOUCHED = "Tenants, API keys, provider keys, balances, the credit ledger and usage records are not touched.";
type Env = RepoEnv & { ADMIN_TENANTS?: string; AGENT_PUBLIC_URL?: string };

async function inventory(env: Env) {
  const agents = (await withSql(env as never, sql => sql.query("select id, tenant from agents where not revoked order by tenant, id"))).rows as { id: string; tenant: string }[];
  const tenants = (await withSql(env as never, sql => sql.query("select id from tenants order by id"))).rows.map(row => String(row.id));
  const repos: { id: string; tenant: string }[] = [];
  for (const tenant of tenants) for await (const repo of liveRepos(env, tenant)) repos.push({ id: repo.id, tenant });
  return { tenants, agents, repos };
}

export async function handlePilotReset(request: Request, env: Env, auth: { tenantId: string; scopes: string[] }) {
  if (request.method !== "POST") return new Response(null, { status: 404 });
  const admins = (env.ADMIN_TENANTS ?? "").split(",").map(value => value.trim());
  if (!admins.includes(auth.tenantId) || !auth.scopes.includes("*"))
    return Response.json({ error: "Admin account required", code: "FORBIDDEN" }, { status: 403 });
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return new Response(null, { status: 403 });
  if ((env.AGENT_PUBLIC_URL ?? "").replace(/\/$/, "") !== PILOT)
    return Response.json({ error: "The pilot reset runs only on the pilot", code: "FORBIDDEN" }, { status: 403 });
  const confirm = new URL(request.url).searchParams.get("confirm") === "1";
  const before = await inventory(env);
  if (!confirm) {
    console.log(JSON.stringify({ type: "pilot_reset", dryRun: true, tenants: before.tenants.length, agents: before.agents.length, repos: before.repos.length }));
    return Response.json({ dryRun: true, wouldDelete: { agents: before.agents, repos: before.repos },
      counts: { tenants: before.tenants.length, agents: before.agents.length, repos: before.repos.length }, untouched: UNTOUCHED },
    { headers: { "cache-control": "no-store" } });
  }
  // Idempotent: a rerun visits only what is still live, so it finishes a partial run.
  const failed: { kind: "agent" | "repo"; id: string; tenant: string; error: string }[] = [];
  for (const agent of before.agents) {
    try {
      const result = await new Directory(env as unknown as ControlEnv, agent.tenant).remove(agent.id);
      if (result && typeof result === "object" && result.failed) failed.push({ kind: "agent", ...agent, error: String(result.error).slice(0, 200) });
    } catch (e) { failed.push({ kind: "agent", ...agent, error: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
  }
  // Agents release their workspace repos as they go; whatever repos remain are deleted directly.
  for (const tenant of before.tenants) for await (const repo of liveRepos(env, tenant)) {
    try { await deleteRepo(env, tenant, repo.id); }
    catch (e) { failed.push({ kind: "repo", id: repo.id, tenant, error: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
  }
  const after = await inventory(env);
  const remaining = { agents: after.agents.length, repos: after.repos.length };
  console.log(JSON.stringify({ type: "pilot_reset", dryRun: false, tenants: before.tenants.length, agents: before.agents.length,
    repos: before.repos.length, failed: failed.length, remainingAgents: remaining.agents, remainingRepos: remaining.repos }));
  const done = !failed.length && !remaining.agents && !remaining.repos;
  return Response.json({ dryRun: false, done, deleted: { agents: before.agents.length - remaining.agents, repos: before.repos.length - remaining.repos },
    remaining, failed, untouched: UNTOUCHED, ...(done ? {} : { next: "Rerun with ?confirm=1: it continues with what is left." }) },
  { status: done ? 200 : 500, headers: { "cache-control": "no-store" } });
}
