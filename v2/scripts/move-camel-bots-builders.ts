import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import pg from "pg";
import { databaseFromEnvironment, type Db } from "../../src/db.ts";
import type { McpServerConfig, V1HistoryImport } from "../sdk/src/index.ts";
import { CamelRun } from "../sdk/src/index.ts";
import { moveAgent } from "./move-agent.ts";
import { stageAgent, verifyCamelBotsDraft } from "./stage-agent.ts";

interface BuilderMove {
  owner: string;
  source: string;
  destination: string;
  operation: string;
  initialCommit?: string;
  previous?: string;
  draftVolumeId?: string;
  attachments?: V1HistoryImport["attachments"];
}

interface BuilderRoute {
  agent: string;
  runtime: "v1" | "hold" | "v2";
  v2_agent: string | null;
  banned_at: Date | null;
}

interface CutoverConfig {
  source: { tenant: string; url: string; apiKey: string };
  destinationTenant: string;
  builderOrigin: string;
}

const OPEN_BRIEFS = ["pending", "sent", "ended"];

async function ownerRoute(sql: pg.PoolClient, owner: string) {
  return (await sql.query<BuilderRoute>(
    `select a.agent, a.runtime, a.v2_agent, u.banned_at
     from builder_agents a join users u on u.id = a.owner where a.owner = $1`, [owner],
  )).rows[0];
}

async function withOwnerLock<T>(sql: pg.PoolClient, owner: string, work: () => Promise<T>) {
  await sql.query("begin");
  try {
    await sql.query("set local lock_timeout = '4s'");
    await sql.query("select pg_advisory_xact_lock(hashtext('camel-builder:' || coalesce(current_schema(), '')), hashtext($1))", [owner]);
    const result = await work();
    await sql.query("commit");
    return result;
  } catch (error) {
    await sql.query("rollback");
    throw error;
  }
}

async function appIdle(sql: pg.PoolClient, runtime: Db, tenant: string, row: BuilderMove) {
  const { rows: [app] } = await sql.query<{ active: boolean; workers: string[] }>(`
    select exists (select from builder_dm_turns where owner = $1 and state <> 'ended')
      or exists (select from manager_briefs where person = $1 and state = any($3::text[]))
      or exists (select from heal_attempts where agent = $2 and state = 'prompted')
      or exists (select from bot_workers where owner = $1 and started_at > now() - interval '30 seconds') as active,
      array(select agent from bot_workers where owner = $1 and started_at is not null) as workers`,
  [row.owner, row.source, OPEN_BRIEFS]);
  if (!app || app.active) return false;
  if (!app.workers.length) return true;
  const { rows: [state] } = await runtime.query<{ active: boolean }>(`
    select exists (
      select from agents a where a.tenant = $1 and a.id = any($2) and a.pending_runs
    ) or exists (
      select from busy_agents b join runtime_nodes n on n.node = b.node and n.session = b.session
      where b.tenant = $1 and b.agent = any($2) and n.expires_at > now()
    ) or exists (
      select from agent_inputs i join agents a on a.id = i.agent where a.tenant = $1 and a.id = any($2)
    ) as active`, [tenant, app.workers]);
  return state?.active === false;
}

async function verifyTarget(v2: CamelRun, config: CutoverConfig, row: BuilderMove) {
  const target = await v2.agents.get(row.destination);
  const info = target.summary as typeof target.summary & {
    tenantId?: string;
    toolIdentity?: { subject: string; context?: Record<string, unknown> };
    mcpServers?: McpServerConfig[];
  };
  const tools = new URL("/builder/mcp/v2", config.builderOrigin).href;
  if (target.id !== row.destination || info.tenantId !== config.destinationTenant ||
      !isDeepStrictEqual(info.toolIdentity, { subject: row.owner, context: { builder: "user" } }) ||
      !info.mcpServers?.some(server => server.name === "bot" && server.url === tools &&
        server.audience === tools && server.auth?.type === "runtime")) {
    throw new Error("destination_identity_mismatch");
  }
}

async function runtimeRoute(runtime: Db, config: CutoverConfig, row: BuilderMove) {
  const { rows: [route] } = await runtime.query<{
    operation: string; destination_tenant: string | null; destination_agent: string | null; archived: boolean;
  }>(`
    select f.operation, r.destination_tenant, r.destination_agent, a.receipts is not null as archived
    from agent_v2_cutovers f
    left join agent_v2_routes r using (tenant, agent)
    left join agent_v2_receipt_archives a using (tenant, agent)
    where f.tenant = $1 and f.agent = $2`, [config.source.tenant, row.source]);
  if (!route) return "v1";
  if (route.operation !== row.operation) throw new Error("another_runtime_cutover");
  if (!route.destination_agent) return "fenced";
  if (route.destination_tenant !== config.destinationTenant || route.destination_agent !== row.destination || !route.archived) {
    throw new Error("published_route_mismatch");
  }
  return "v2";
}

async function updateRoute(sql: pg.PoolClient, row: BuilderMove, from: "v1" | "hold", to: "v1" | "hold" | "v2") {
  const update = await sql.query(`
    update builder_agents set runtime = $4, v2_agent = $5, updated_at = now()
    where owner = $1 and agent = $2 and runtime = $3 and v2_agent is not distinct from $6`,
  [row.owner, row.source, from, to, to === "v1" ? null : row.destination, from === "v1" ? null : row.destination]);
  if (update.rowCount !== 1) throw new Error("app_cutover_changed");
}

/** Every rendered Camel Bots attachment needs its original workspace path and a pinned copy. */
export function validateBuilderAttachments(messages: unknown[], attachments: V1HistoryImport["attachments"]) {
  const blocks = new Map(attachments?.map(entry => [entry.messageIndex, entry.files]));
  for (const [index, value] of messages.entries()) {
    const message = value as { role?: unknown; content?: unknown };
    if (message?.role !== "user") continue;
    const texts = typeof message.content === "string" ? [message.content]
      : Array.isArray(message.content) ? message.content.filter(block => block?.type === "text").map(block => block.text) : [];
    for (const text of texts) {
      if (typeof text !== "string") continue;
      // Match the suffix the app renders as attachments. Paths outside /workspace require separate preservation.
      const block = /<attached>\n[^\n]*\n((?:[^\n]*\n)*?)<\/attached>\s*$/.exec(text);
      if (!block) continue;
      for (const line of block[1]!.split("\n")) {
        if (!line.trim()) continue;
        let source: { path?: unknown; type?: unknown };
        try { source = JSON.parse(line); }
        catch { throw new Error("builder_attachment_manifest_required"); }
        if (typeof source?.path !== "string" || !source.path.startsWith("/workspace/") ||
            !blocks.get(index)?.some(file => file.path === source.path && file.contentType === source.type)) {
          throw new Error("builder_attachment_manifest_required");
        }
      }
    }
  }
}

export async function moveCamelBotsBuilder(
  bots: pg.Pool, runtime: Db, v2: CamelRun, config: CutoverConfig, row: BuilderMove,
  apply: boolean,
  relocate = moveAgent,
  stage = stageAgent,
) {
  const sql = await bots.connect();
  let unlock = false;
  let destroy = false;
  try {
    // Operators can run independent batches, but only one process may work on a given builder.
    const { rows: [lock] } = await sql.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext('camel-builder-cutover:' || coalesce(current_schema(), '')), hashtext($1)) as acquired",
      [row.owner],
    );
    if (!lock?.acquired) return { owner: row.owner, state: "deferred" as const };
    unlock = true;

    const app = await ownerRoute(sql, row.owner);
    if (!app || app.agent !== row.source || app.banned_at) throw new Error("builder_owner_changed");
    if (app.runtime === "v2" && app.v2_agent !== row.destination) throw new Error("app_destination_changed");
    if (app.runtime === "hold" && app.v2_agent !== row.destination) throw new Error("another_app_cutover");
    const legacy = await runtimeRoute(runtime, config, row);
    const source = { ...config.source, agentId: row.source, operation: row.operation };
    const options = {
      initialCommit: row.initialCommit,
      previous: row.previous,
      attachments: row.attachments,
      validateHistory: (messages: unknown[]) => validateBuilderAttachments(messages, row.attachments),
      sharedDraft: row.draftVolumeId ? {
        volumeId: row.draftVolumeId,
        verify: async (agentId: string, volumeId: string) => {
          const found = await verifyCamelBotsDraft(sql, agentId, volumeId);
          return found?.owner === row.owner ? found : null;
        },
      } : undefined,
    };
    if (app.runtime === "v2") {
      if (legacy !== "v2") throw new Error("app_route_without_runtime_route");
      return { owner: row.owner, state: "published" as const };
    }
    if (legacy !== "v1" && app.runtime !== "hold") throw new Error("runtime_route_without_app_hold");
    await verifyTarget(v2, config, row);

    if (!apply) {
      if (app.runtime !== "v1") throw new Error("resume_with_apply");
      if (!await appIdle(sql, runtime, config.source.tenant, row)) return { owner: row.owner, state: "deferred" as const };
      const receipt = await stage(source, v2, row.destination, options);
      return { owner: row.owner, state: "staged" as const, receipt };
    }

    if (legacy === "v1" && !row.previous) throw new Error("stage_first");
    if (app.runtime === "v1") {
      const held = await withOwnerLock(sql, row.owner, async () => {
        const current = await ownerRoute(sql, row.owner);
        if (!current || current.agent !== row.source || current.runtime !== "v1" || current.banned_at) throw new Error("builder_owner_changed");
        if (!await appIdle(sql, runtime, config.source.tenant, row)) return false;
        await updateRoute(sql, row, "v1", "hold");
        return true;
      });
      if (!held) return { owner: row.owner, state: "deferred" as const };
    }

    const releaseIfUnpublished = async () => {
      if (await runtimeRoute(runtime, config, row) !== "v1") return;
      await withOwnerLock(sql, row.owner, () => updateRoute(sql, row, "hold", "v1"));
    };
    let receipt: unknown;
    try {
      if (legacy !== "v2") {
        const moved = await relocate(runtime, source, v2, { tenant: config.destinationTenant, agent: row.destination }, options);
        if (moved.state === "deferred") {
          await releaseIfUnpublished();
          return { owner: row.owner, state: "deferred" as const };
        }
        receipt = moved;
      }
    } catch (error) {
      // An uncertain publication stays held. A retry reads the durable runtime route before touching the app.
      try { await releaseIfUnpublished(); }
      catch (release) { throw new AggregateError([error, release], "release_builder_hold_failed"); }
      throw error;
    }
    if (await runtimeRoute(runtime, config, row) !== "v2") throw new Error("runtime_route_not_confirmed");
    await withOwnerLock(sql, row.owner, async () => {
      const current = await ownerRoute(sql, row.owner);
      if (!current || current.agent !== row.source || current.banned_at) throw new Error("builder_owner_changed");
      await updateRoute(sql, row, "hold", "v2");
    });
    return { owner: row.owner, state: "published" as const, receipt };
  } finally {
    if (unlock) {
      try {
        const { rows: [lock] } = await sql.query<{ released: boolean }>(
          "select pg_advisory_unlock(hashtext('camel-builder-cutover:' || coalesce(current_schema(), '')), hashtext($1)) as released",
          [row.owner],
        );
        destroy = !lock?.released;
      } catch { destroy = true; }
    }
    sql.release(destroy);
  }
}

const id = /^[a-zA-Z0-9_-]{1,128}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { apply: { type: "boolean" } } });
  if (positionals.length !== 1) throw new Error("Usage: move-camel-bots-builders.ts <manifest.json> [--apply]");
  const batch: BuilderMove[] = JSON.parse(await readFile(positionals[0]!, "utf8"));
  const unique = (read: (row: BuilderMove) => string) => new Set(batch.map(read)).size === batch.length;
  if (!Array.isArray(batch) || !batch.length || batch.some(row => !row ||
      !/^\d{17,20}$/.test(row.owner) || !id.test(row.source) || !/^agt_[a-f0-9]{16}$/.test(row.destination) ||
      !uuid.test(row.operation) || (row.initialCommit !== undefined && !/^[a-f0-9]{64}$/.test(row.initialCommit)) ||
      (row.previous !== undefined && !/^[a-f0-9]{64}$/.test(row.previous)) ||
      (row.draftVolumeId !== undefined && !id.test(row.draftVolumeId))) ||
      !unique(row => row.owner) || !unique(row => row.source) || !unique(row => row.destination) || !unique(row => row.operation)) {
    throw new Error("Invalid or duplicate builder migration manifest entries");
  }
  const { tenantId, apiKey } = JSON.parse(env("BUILDER_V2_TENANT")) as { tenantId: string; apiKey: string };
  if (typeof tenantId !== "string" || !tenantId || typeof apiKey !== "string" || !apiKey) {
    throw new Error("Invalid BUILDER_V2_TENANT");
  }
  const config = {
    source: { tenant: env("V1_TENANT"), url: env("V1_URL"), apiKey: env("V1_API_KEY") },
    destinationTenant: tenantId,
    builderOrigin: env("CAMEL_BOTS_ORIGIN"),
  };
  const v2 = new CamelRun({ baseUrl: env("V2_URL"), apiKey });
  const bots = new pg.Pool({ connectionString: env("CAMEL_BOTS_DATABASE_URL"), max: 2, connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
  const runtime = await databaseFromEnvironment();
  try {
    if ((await v2.me()).tenantId !== tenantId) throw new Error("Shared v2 key belongs to another tenant");
    for (const row of batch) {
      try {
        console.log(JSON.stringify(await moveCamelBotsBuilder(bots, runtime, v2, config, row, values.apply === true)));
      } catch (error) {
        const reason = error instanceof Error && /^[a-z][a-z0-9_]{2,70}$/.test(error.message) ? error.message : "builder_cutover_failed";
        const saved = error instanceof Error ? /written with receipt ([a-f0-9]{64})/.exec(error.message)?.[1] : undefined;
        console.log(JSON.stringify({ owner: row.owner, state: "failed", reason, ...(saved ? { previous: saved } : {}) }));
        process.exitCode = 1;
      }
    }
  } finally {
    await Promise.all([v2.close(), bots.end(), runtime.end()]);
  }
}
