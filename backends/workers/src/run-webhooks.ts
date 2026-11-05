import { outcomeEnding, type Outcome } from "../../../shared/client-protocol.ts";
import { enqueueEvents, webhookEvent } from "./webhook-policy.ts";
import { withSql, type PostgresEnv } from "./postgres.ts";

/** Same fields and idempotency key as ClientSessions.runEvent in the source host. */
export async function enqueueRunWebhook(env: PostgresEnv, tenant: string, agentId: string, record: {
  id: string; method: string; actor?: string; metadata?: unknown; steeredInto?: string;
  outcome?: { result?: unknown; error?: string };
}) {
  const outcome = record.outcome ?? { error: "No outcome was recorded" };
  const result = (outcome.result ?? {}) as Record<string, any>;
  const base = { agentId, requestId: record.id, method: record.method,
    ...(record.actor ? { actor: record.actor } : {}), ...(record.metadata ? { metadata: record.metadata } : {}) };
  const { error } = outcomeEnding(outcome as Outcome);
  const ended = { ...base, ...(record.steeredInto ? { steeredInto: record.steeredInto } : {}),
    usage: result.usage ?? null, ...(result.servedModel ? { servedModel: result.servedModel } : {}) };
  const coded = Object.fromEntries(["code", "limit", "reason", "bucket", "endUser"].flatMap(name => typeof result[name] === "string" ? [[name, result[name]]] : []));
  const key = `run.ended:${agentId}:${record.id}`;
  const event = error !== undefined
    ? webhookEvent("run.failed", tenant, { ...ended, error, ...coded, ...(outcome.error === undefined ? result.modelError : {}) }, key)
    : webhookEvent("run.completed", tenant, { ...ended, ...(result.stopped ? { stopped: result.stopped } : {}),
      ...(result.inputs?.length ? { inputIds: result.inputs.map((input: { id: string }) => input.id) } : {}),
      ...(typeof result.replyIndex === "number" ? { replyIndex: result.replyIndex } : {}),
      ...(typeof result.messages === "number" ? { messageCount: result.messages } : {}) }, key);
  await withSql(env, sql => enqueueEvents(sql, [event]));
}
