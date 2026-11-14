import { applyScope } from "../../../../shared/apply-scope.ts";
import { transaction, withSql, type PostgresEnv, type Sql } from "../postgres.ts";

export type AttachmentHintEnv = PostgresEnv & {
  AGENTS: { getByName(agent: string): { clearComputerAttached(): Promise<boolean> } };
};
export type LocalAttachmentHint = {
  agent: string;
  clearComputerAttached(): Promise<boolean>;
};

export async function writeComputerConnections<T>(
  env: AttachmentHintEnv,
  write: (sql: Sql) => Promise<{ value: T; agents: string[] }>,
  local?: LocalAttachmentHint,
): Promise<T> {
  if (applyScope.getStore()) throw new Error("Computer connection writes require their own transaction");
  const token = crypto.randomUUID();
  const { value, agents } = await transaction(env, async sql => {
    const result = await write(sql);
    if (result.agents.length)
      await sql.query(`insert into computer_attachment_clears(agent,token)
        select distinct agent,$2::uuid from unnest($1::text[]) as ids(agent)
        on conflict(agent) do update set token=excluded.token,due_at=now()`, [result.agents, token]);
    return result;
  });
  try {
    for (const agent of agents) await clear(env, agent, token, local);
  } catch (error) {
    throw new ComputerHintClearError(error);
  }
  return value;
}

export class ComputerHintClearError extends Error {
  constructor(cause: unknown) {
    super("Computer connection change committed; attachment hint clear is pending", { cause });
  }
}

async function clear(env: AttachmentHintEnv, agent: string, token: string, local?: LocalAttachmentHint) {
  if (local?.agent === agent) await local.clearComputerAttached();
  else await env.AGENTS.getByName(agent).clearComputerAttached();
  // An overlapping writer's newer token stays pending until its own post-commit clear.
  await withSql(env, sql => sql.query("delete from computer_attachment_clears where agent=$1 and token=$2", [agent, token]));
}

export async function sweepComputerAttachmentClears(env: AttachmentHintEnv) {
  // Claim before RPC so one failing object does not block other agents, even across maintenance invocations.
  const { rows } = await withSql(env, sql => sql.query<{ agent: string; token: string }>(`
    update computer_attachment_clears set due_at=now()+interval '1 minute'
    where agent in (select agent from computer_attachment_clears where due_at<=now()
      order by due_at limit 100 for update skip locked)
    returning agent,token`));
  for (const { agent, token } of rows) {
    try { await clear(env, agent, token); }
    catch (error) { console.error(JSON.stringify({ type: "computer_attachment_clear_failed", agent, error: (error as Error).name })); }
  }
}
