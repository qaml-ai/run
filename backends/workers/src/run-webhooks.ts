import { outcomeEnding, type Outcome } from "../../../shared/client-protocol.ts";
import { withSql, type PostgresEnv } from "./postgres.ts";
import { enqueueEvents, webhookEvent, type WebhookEvent } from "./webhook-policy.ts";
import { publishPending, type WebhookEnv } from "./webhooks.ts";

const PENDING = "webhook-pending:";
const SENT = "webhook-sent:";
const RUN_METHODS = new Set(["prompt", "execute", "continue", "steer", "resume"]);
type Run = {
  id: string; method: string; state: string; actor?: string; metadata?: unknown;
  resumes?: number; steeredInto?: string; outcome?: { result?: unknown; error?: string; uncertain?: boolean };
};
type Owner = { id: string; tenantId: string };

/** The source run contract, projected from the request committed in this object. */
export function runWebhook(owner: Owner, record: Run, messageCount?: number): WebhookEvent | undefined {
  if (!RUN_METHODS.has(record.method)) return;
  const base = { agentId: owner.id, requestId: record.id, method: record.method,
    ...(record.actor ? { actor: record.actor } : {}), ...(record.metadata ? { metadata: record.metadata } : {}) };
  if (record.state !== "completed") return webhookEvent("run.started", owner.tenantId,
    { ...base, ...(record.resumes ? { resumes: record.resumes } : {}) }, `run.started:${owner.id}:${record.id}`);
  const outcome = record.outcome ?? { error: "No outcome was recorded" };
  const result = (outcome.result ?? {}) as Record<string, any>;
  const { error } = outcomeEnding(outcome as Outcome);
  const ended = { ...base, ...(record.steeredInto ? { steeredInto: record.steeredInto } : {}),
    usage: result.usage ?? null, ...(result.servedModel ? { servedModel: result.servedModel } : {}) };
  const key = `run.ended:${owner.id}:${record.id}`;
  if (error !== undefined) {
    const coded = Object.fromEntries(["code", "limit", "reason", "bucket", "endUser"]
      .flatMap(name => typeof result[name] === "string" ? [[name, result[name]]] : []));
    return webhookEvent("run.failed", owner.tenantId, { ...ended, error, ...coded,
      ...(outcome.error === undefined ? result.modelError : {}), ...(outcome.uncertain ? { uncertain: true } : {}) }, key);
  }
  return webhookEvent("run.completed", owner.tenantId, { ...ended,
    ...(result.stopped ? { stopped: result.stopped } : {}),
    ...(result.inputs?.length ? { inputIds: result.inputs.map((input: { id: string }) => input.id) } : {}),
    ...(typeof result.replyIndex === "number" ? { replyIndex: result.replyIndex } : {}),
    ...(typeof result.messages === "number" || messageCount !== undefined
      ? { messageCount: typeof result.messages === "number" ? result.messages : messageCount } : {}),
  }, key);
}

/** The terminal-event recovery path shares the durable outbox's exact projection and key. */
export async function enqueueRunWebhook(env: PostgresEnv, tenant: string, agentId: string, record: Omit<Run, "state">) {
  const event = runWebhook({ id: agentId, tenantId: tenant }, { ...record, state: "completed" });
  if (event) await withSql(env, sql => enqueueEvents(sql, [event]));
}

export function inputWebhook(owner: Owner, requestId: string, input: {
  id: string; toolCallId?: string; kind?: string; expiresAt?: number; state?: string;
}, resolved = false): WebhookEvent {
  const type = resolved ? "input.resolved" : "input.requested";
  return webhookEvent(type, owner.tenantId, {
    agentId: owner.id, requestId, inputId: input.id,
    ...(resolved ? { state: input.state } : { toolCallId: input.toolCallId, kind: input.kind, expiresAt: input.expiresAt }),
  }, `${type}:${owner.id}:${input.id}`);
}

/** Persist intent beside the stream event. PostgreSQL failure leaves it for the next run/load. */
export async function stageWebhook(tx: Pick<DurableObjectTransaction, "get" | "put">, event: WebhookEvent) {
  if (!await tx.get(`${SENT}${event.id}`) && !await tx.get(`${PENDING}${event.id}`))
    await tx.put(`${PENDING}${event.id}`, event);
}

export class AgentWebhooks {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly storage: DurableObjectStorage, private readonly env: WebhookEnv) {}
  settled(): Promise<void> { return this.pending; }
  flush(): Promise<void> {
    const next = this.pending.then(async () => {
      let published = false;
      for (const [key, event] of await this.storage.list<WebhookEvent>({ prefix: PENDING, limit: 100 })) {
        try {
          await withSql(this.env, sql => enqueueEvents(sql, [event]));
          await this.storage.transaction(async tx => {
            await tx.put(`${SENT}${event.id}`, true);
            await tx.delete(key);
          });
          published = true;
        } catch {
          // The request's terminal event is independently durable and readable.
          // Retry this intent when the next run or object load flushes the outbox.
        }
      }
      if (published) await publishPending(this.env);
    });
    this.pending = next.catch(() => {});
    return this.pending;
  }
}
