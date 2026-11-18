import { openSecret, randomId, signWebhookPayload } from "./crypto.ts";
import { getTenantStub, type WebhookView } from "./tenant-do.ts";
import type { Env, QueueMessagePayload } from "./types.ts";

export type { WebhookView };

export async function createWebhookRecord(
  env: Env,
  tenantId: string,
  input: { url: string; events?: string[]; secret?: string },
): Promise<WebhookView & { secret: string }> {
  return getTenantStub(env, tenantId).createWebhook(input);
}

export async function listWebhookRecords(env: Env, tenantId: string): Promise<WebhookView[]> {
  return getTenantStub(env, tenantId).listWebhooks();
}

export async function deleteWebhookRecord(
  env: Env,
  tenantId: string,
  webhookId: string,
): Promise<boolean> {
  return getTenantStub(env, tenantId).deleteWebhook(webhookId);
}

export async function enqueueWebhookEvent(
  env: Env,
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const msg: Extract<QueueMessagePayload, { kind: "webhook" }> = {
      kind: "webhook",
      tenantId,
      eventType,
      eventId: randomId("evt", 8),
      createdAt: Date.now(),
      payload,
    };
    if (env.EVENTS_QUEUE) {
      await env.EVENTS_QUEUE.send(msg);
    } else {
      await deliverWebhookMessage(env, msg);
    }
  } catch {
    // Non-fatal if queue producer or webhook endpoint is unavailable
  }
}

export async function processEventsQueueBatch(
  batch: MessageBatch<QueueMessagePayload>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const body = msg.body;
      if (body.kind === "webhook") {
        await deliverWebhookMessage(env, body);
      } else if (body.kind === "channel_reply") {
        await deliverChannelReplyMessage(env, body);
      }
      msg.ack();
    } catch {
      msg.retry();
    }
  }
}

export async function deliverWebhookMessage(
  env: Env,
  item: Extract<QueueMessagePayload, { kind: "webhook" }>,
): Promise<void> {
  const hooks = await getTenantStub(env, item.tenantId).listEnabledWebhookTargets();
  if (hooks.length === 0) return;

  const envelope = JSON.stringify({
    id: item.eventId,
    type: item.eventType,
    tenantId: item.tenantId,
    createdAt: item.createdAt,
    data: item.payload,
  });

  await Promise.all(
    hooks.map(async (hook) => {
      const subscribed = hook.events?.length ? hook.events : ["*"];
      const norm = (s: string) => s.replace(/^agent\./, "").replaceAll(".", "_");
      if (
        !subscribed.includes("*") &&
        !subscribed.some((s) => s === item.eventType || norm(s) === norm(item.eventType))
      ) {
        return;
      }
      const secret = await openSecret(hook.sealedSecret, env.VAULT_SECRET);
      const { signature, timestamp } = await signWebhookPayload(envelope, secret);

      const res = await fetch(hook.url, {
        method: "POST",
        ...(item.eventType === "usage.recorded" ? { signal: AbortSignal.timeout(10_000) } : {}),
        headers: {
          "Content-Type": "application/json",
          "X-CamelRun-Signature": signature,
          "X-CamelRun-Event": item.eventType,
          "X-CamelRun-Delivery": item.eventId,
          "X-CamelRun-Timestamp": String(timestamp),
        },
        body: envelope,
      });
      if (!res.ok && (item.eventType === "usage.recorded" || res.status >= 500)) {
        throw new Error(`Webhook ${hook.id} failed with HTTP ${res.status}`);
      }
    }),
  );
}

async function deliverChannelReplyMessage(
  env: Env,
  item: Extract<QueueMessagePayload, { kind: "channel_reply" }>,
): Promise<void> {
  if (!item.outboundUrl) return;

  const payload =
    item.channelKind === "slack"
      ? JSON.stringify({
          text: item.replyText,
          thread_ts: item.threadId !== "default" ? item.threadId : undefined,
        })
      : JSON.stringify({
          channelId: item.channelId,
          kind: item.channelKind,
          threadId: item.threadId,
          agentId: item.agentId,
          runId: item.runId,
          text: item.replyText,
          meta: item.meta ?? {},
        });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (item.sealedSecret) {
    const secret = await openSecret(item.sealedSecret, env.VAULT_SECRET);
    const { signature } = await signWebhookPayload(payload, secret);
    headers["X-CamelRun-Signature"] = signature;
  }

  const res = await fetch(item.outboundUrl, {
    method: "POST",
    headers,
    body: payload,
  });
  if (!res.ok && res.status >= 500) {
    throw new Error(`Channel outbound ${item.channelId} failed with HTTP ${res.status}`);
  }
}
