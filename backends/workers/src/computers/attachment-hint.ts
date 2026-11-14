import { applyScope } from "../../../../shared/apply-scope.ts";
import { transaction, type PostgresEnv, type Sql } from "../postgres.ts";

export type AttachmentHintEnv = PostgresEnv & {
  AGENTS: { getByName(agent: string): { clearComputerAttached(): Promise<boolean> } };
};
export type LocalAttachmentHint = {
  agent: string;
  clearComputerAttached(): Promise<boolean>;
};

/**
 * A failed clear is not retried. It can leave the agent's hint stale `false` only until its next
 * tool discovery. admitImpl (agent-admission.ts) calls refreshComputerTools before each Pi turn.
 * A lease on an agent's own connection is started only by those tools, and a sharer reaches the
 * owner's connection only after the owner has run, so a stale `false` never coexists with a live lease.
 * INVARIANT: discovery precedes tools. If admission ever stops refreshing tools before a turn, or
 * a lease can start without the owner's discovery, this clear must become durable.
 */
export async function writeComputerConnections<T>(
  env: AttachmentHintEnv,
  write: (sql: Sql) => Promise<{ value: T; agents: string[] }>,
  local?: LocalAttachmentHint,
): Promise<T> {
  if (applyScope.getStore()) throw new Error("Computer connection writes require their own transaction");
  const { value, agents } = await transaction(env, write);
  let failure: ComputerHintClearError | undefined;
  for (const agent of agents) {
    try {
      if (local?.agent === agent) await local.clearComputerAttached();
      else await env.AGENTS.getByName(agent).clearComputerAttached();
    } catch (error) {
      failure ??= new ComputerHintClearError(error);
    }
  }
  if (failure) throw failure;
  return value;
}

export class ComputerHintClearError extends Error {
  constructor(cause: unknown) {
    super("Computer connection change committed; attachment hint clear failed", { cause });
  }
}
