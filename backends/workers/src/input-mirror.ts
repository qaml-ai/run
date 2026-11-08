import { createHash } from "node:crypto";
import type { humanInputView } from "./human.ts";
import { transaction, type Sql } from "./postgres.ts";
import type { Env } from "./agent-types.ts";

const PENDING = "input-mirror-pending:";
export type InputMirror = ReturnType<typeof humanInputView> & {
  tenant: string; subject: string | null; audience: string[]; lineage: string[]; subagent?: boolean;
};

// Pi task IDs repeat across agents. Keep the public Pi ID in the payload for routing an answer.
export const mirrorId = (agent: string, id: string) => `inp_${createHash("sha256").update(JSON.stringify([agent, id])).digest("hex")}`;

export async function stageInputMirror(tx: Pick<DurableObjectTransaction, "get" | "put">, row: InputMirror) {
  const key = `${PENDING}${row.id}`;
  const previous = await tx.get<InputMirror>(key);
  if (!previous || previous.version <= row.version) await tx.put(key, row);
}

export async function upsertInputMirrors(sql: Sql, rows: InputMirror[]) {
  for (const row of rows) {
    // A background sub-agent may have a fresh run without signed parent metadata.
    // Resolve its recorded ancestry here, so staging still works while Postgres is down.
    let lineage = row.lineage;
    if (row.subagent && lineage.length === 1) {
      const parent = (await sql.query(`select header->'parentPlace'->'chain' as chain,
        header->>'parentAgentId' as parent from agents where id=$1 and tenant=$2`, [row.agent, row.tenant])).rows[0];
      if (Array.isArray(parent?.chain)) lineage = [...parent.chain, row.agent];
      else if (parent?.parent) lineage = [parent.parent, row.agent];
    }
    const priority = row.kind === "approval" ? "high" : "normal";
    const result = await sql.query(`insert into agent_inputs
      (id, agent, tenant, request_id, tool_call_id, kind, state, input, answer, created_at, expires_at,
       priority, priority_rank, blocking, subject, responders, root_agent, lineage, version)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$15,$16,$17,$18)
      on conflict (id) do update set state=excluded.state, input=excluded.input, answer=excluded.answer,
        expires_at=excluded.expires_at, version=excluded.version, updated_at=now()
      where agent_inputs.version < excluded.version returning tenant`,
    [mirrorId(row.agent, row.id), row.agent, row.tenant, row.requestId, row.toolCallId, row.kind, row.state,
      JSON.stringify({ message: row.message, detail: row.detail, responders: row.responders, workersInputId: row.id }),
      row.answer ? JSON.stringify(row.answer) : null, row.createdAt, row.expiresAt, priority, priority === "high" ? 1 : 2,
      row.subject, row.audience, lineage[0], lineage, row.version]);
    if (result.rowCount) await sql.query("select pg_notify('inbox', $1)", [row.tenant]);
  }
}

export async function pendingInputMirrors(storage: DurableObjectStorage) {
  return storage.list<InputMirror>({ prefix: PENDING, limit: 100 });
}

/** Lease at most 100 old pending rows. RPCs run after releasing the SQL transaction. */
export async function sweepInputMirrors(env: Env) {
  const rows = await transaction(env, async sql => (await sql.query(`
    with stale as (
      select id from agent_inputs where state='pending' and input ? 'workersInputId'
        and updated_at < now() - interval '1 hour' and (claimed_until is null or claimed_until < now())
      order by updated_at limit 100 for update skip locked
    ) update agent_inputs set claimed_until=now() + interval '1 hour'
      where id in (select id from stale) returning id, version, agent, tenant, input->>'workersInputId' as input_id`)).rows);
  const agents = new Map<string, { tenant: string; ids: string[]; rows: { id: string; version: number; input_id: string }[] }>();
  for (const row of rows) {
    const group = agents.get(row.agent) ?? { tenant: row.tenant, ids: [] as string[], rows: [] as { id: string; version: number; input_id: string }[] };
    group.ids.push(row.input_id);
    group.rows.push(row);
    agents.set(row.agent, group);
  }
  const groups = [...agents];
  let failed = false;
  for (let offset = 0; offset < groups.length; offset += 10) {
    const results = await Promise.allSettled(groups.slice(offset, offset + 10).map(async ([agent, group]) => {
      const response = await env.AGENTS.getByName(agent).fetch(new Request("https://agent/_input-mirror", {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ tenant: group.tenant, ids: group.ids }),
      }));
      if (response.status === 404 || response.status === 410) {
        await withdrawInputMirrors(env, agent, group.tenant);
        return;
      }
      if (!response.ok) throw new Error(`Input mirror refresh failed (${response.status})`);
      const result = await response.json() as { missing?: string[] };
      const missing = group.rows.filter(row => result.missing?.includes(row.input_id));
      if (missing.length) await withdrawInputMirrors(env, agent, group.tenant, missing);
    }));
    failed ||= results.some(result => result.status === "rejected");
  }
  if (failed) throw new Error("Input mirror sweep could not refresh every agent");
}

/** Missing authority is terminal; a stale sweep must not overwrite a newer mirror. */
async function withdrawInputMirrors(env: Env, agent: string, tenant: string, expected?: { id: string; version: number }[]) {
  await transaction(env, async sql => {
    const result = await sql.query(`update agent_inputs set state='withdrawn', version=version+1, updated_at=now(), claimed_until=null
      where agent=$1 and tenant=$2 and state='pending' and input ? 'workersInputId'
      and ($3::jsonb is null or exists (select 1 from jsonb_to_recordset($3::jsonb) as r(id text, version integer)
        where r.id=agent_inputs.id and r.version=agent_inputs.version)) returning id`,
      [agent, tenant, expected ? JSON.stringify(expected) : null]);
    if (result.rowCount) await sql.query("select pg_notify('inbox', $1)", [tenant]);
  });
}
