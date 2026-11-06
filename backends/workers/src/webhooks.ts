import {
  withSql,
  transaction,
  type PostgresEnv,
  type Sql,
} from "./postgres.ts";
import { digest } from "./api-contract.ts";
import { isIP } from "node:net";
import { HttpError } from "./errors.ts";
import { metric } from './observability.ts';

export { webhookEvent, enqueueEvents, usageEvent, usageCost } from "./webhook-policy.ts";
export type { WebhookEvent } from "./webhook-policy.ts";
export type DeliveryMessage = { id: string; kind?: "email" | "schedule" | "account_deletion" };
export type WebhookEnv = PostgresEnv & {
  WEBHOOKS?: Queue<DeliveryMessage>;
  API_TOKEN: string;
  TEST_MODE?: string;
  MAIL?: SendEmail;
  ACCOUNT_EMAIL_FROM?: string;
  WEBHOOK_ALLOWED_HOSTS?: string;
  METRICS?: AnalyticsEngineDataset;
};
const deliveryBoots = new WeakMap<Queue<DeliveryMessage>, Promise<void>>();

/** Repair a missing queue wake-up once per isolate. Postgres owns the retry time. */
export function resumeWebhookDeliveries(env: WebhookEnv): Promise<void> | undefined {
  const queue = env.WEBHOOKS;
  if (!queue || deliveryBoots.has(queue)) return;
  const boot = withSql(env, sql => sql.query(
    "select id,due from (select id,due from webhook_deliveries union all select id,due from usage_webhook_outbox) pending order by due limit 1",
  )).then(async ({ rows }) => {
    if (!rows.length) return;
    await queue.send({ id: rows[0].id }, {
      delaySeconds: Math.min(43_200, Math.max(0, Math.ceil((Number(rows[0].due) - Date.now()) / 1000))),
    });
  }).catch(error => {
    deliveryBoots.delete(queue);
    throw error;
  });
  deliveryBoots.set(queue, boot);
  return boot;
}
export async function stableUuid(value: string): Promise<string> {
  const h = await digest(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function seal(secret: string, env: WebhookEnv) {
  const raw = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(env.API_TOKEN),
  );
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(secret),
  );
  return {
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
  };
}
export async function unseal(
  value: { iv: string; ciphertext: string },
  env: WebhookEnv,
) {
  const raw = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(env.API_TOKEN),
  );
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "decrypt",
  ]);
  const bytes = (text: string) =>
    Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes(value.iv) },
      key,
      bytes(value.ciphertext),
    ),
  );
}

export async function createEndpoint(
  env: WebhookEnv,
  tenant: string,
  input: { url?: unknown; events?: unknown; description?: unknown },
) {
  if (typeof input.url !== "string")
    throw new HttpError(400, "url is required");
  const url = new URL(input.url);
  const hostname = url.hostname.toLowerCase();
  const local =
    env.TEST_MODE === "1" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(hostname) &&
    url.protocol === "http:";
  const allowed = new Set(
    (env.WEBHOOK_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  // Public receivers require an operator allowlist. IP literals are denied wholesale;
  // DNS resolution/rebinding protections remain a deployment responsibility.
  const lexicalPrivate =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    isIP(hostname.replace(/^\[|\]$/g, "")) !== 0;
  if (url.username || url.password)
    throw new HttpError(400, "Webhook URL must not include credentials");
  if (
    !local &&
    (url.protocol !== "https:" || lexicalPrivate || !allowed.has(hostname))
  )
    throw new HttpError(
      400,
      "Webhook receiver must be an operator-allowlisted HTTPS hostname",
    );
  const events = input.events ?? ["usage"];
  if (
    !Array.isArray(events) ||
    events.length < 1 ||
    events.length > 30 ||
    events.some((x) => typeof x !== "string" || x.length > 80)
  )
    throw new HttpError(400, "events must be a bounded string array");
  const id = `wh_${crypto.randomUUID()}`,
    secret = `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`;
  const encrypted = await seal(secret, env),
    createdAt = Date.now();
  await withSql(env, (sql) =>
    sql.query(
      "insert into webhook_endpoints(id,tenant,url,events,description,secret,created_at) values($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        tenant,
        url.href,
        events,
        input.description ?? null,
        JSON.stringify(encrypted),
        createdAt,
      ],
    ),
  );
  return { id, url: url.href, events, secret, createdAt };
}

/** One snapshot and one database round trip for all delivery wake-ups. */
export async function pendingDeliveries(sql: Sql, now = Date.now()) {
  const { rows: [pending] } = await sql.query(`
    select count(*) as pending, min(created_at) as oldest,
      coalesce((select jsonb_agg(d.id) from (
        select id from (select id,due from webhook_deliveries union all select id,due from usage_webhook_outbox) d
        where due <= $1 order by due limit 100
      ) d), '[]'::jsonb) as deliveries,
      coalesce((select jsonb_agg(e.key) from (
        select key from idempotency_keys where key like 'workers:email:%' and status=102 order by created_at limit 100
      ) e), '[]'::jsonb) as emails
    from webhook_deliveries`, [now]);
  return pending as { pending: number; oldest: number | null; deliveries: string[]; emails: string[] };
}

export async function publishPending(env: WebhookEnv): Promise<number> {
  if (!env.WEBHOOKS) return 0;
  const backlog = await withSql(env, sql => pendingDeliveries(sql));
  metric(env,'webhook_backlog',{WebhookBacklog:Number(backlog.pending),WebhookOldestPendingMs:backlog.oldest === null ? 0 : Math.max(0,Date.now()-Number(backlog.oldest))});
  if (backlog.deliveries.length)
    await env.WEBHOOKS.sendBatch(backlog.deliveries.map(id => ({ body: { id } })));
  if (backlog.emails.length)
    await env.WEBHOOKS.sendBatch(
      backlog.emails.map(key => ({
        body: {
          id: key.slice("workers:email:".length),
          kind: "email" as const,
        },
      })),
    );
  return backlog.deliveries.length + backlog.emails.length;
}
export async function deliver(env: WebhookEnv, id: string): Promise<void> {
  const row = await transaction(env, async (sql) => {
    const { rows } = await sql.query(
      "select d.*,e.url,e.secret from webhook_deliveries d join webhook_endpoints e on e.id=d.endpoint and e.tenant=d.tenant where d.id=$1 and d.due <= $2 for update of d",
      [id, Date.now()],
    );
    if (!rows[0]) return undefined;
    await sql.query(
      "update webhook_deliveries set due=$2,attempts=attempts+1 where id=$1",
      [id, Date.now() + 60_000],
    );
    return rows[0];
  });
  if (!row) return;
  const body = JSON.stringify(row.body),
    timestamp = Math.floor(Date.now() / 1000).toString();
  const secret = await unseal(row.secret, env);
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  try {
    const response = await fetch(row.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`,
      },
      body,
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("receiver returned an error");
    await withSql(env, (sql) =>
      sql.query("delete from webhook_deliveries where id=$1", [id]),
    );
    metric(env,'webhook_delivered',{WebhooksDelivered:1,WebhookDeliveryLagMs:Math.max(0,Date.now()-Number(row.created_at)),WebhookAttempts:Number(row.attempts)+1},{Kind:'endpoint'});
  } catch (error) {
    metric(env,'webhook_failed',{WebhooksFailed:1},{Kind:'endpoint'});
    const detail =
      env.TEST_MODE === "1" && error instanceof Error
        ? error.message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 200)
        : "delivery failed";
    await withSql(env, (sql) =>
      sql.query(
        "update webhook_deliveries set due=$2,last_error=$3 where id=$1",
        [
          id,
          Date.now() +
            Math.min(
              3600000,
              1000 * 2 ** Math.min(Number(row.attempts) + 1, 12),
            ),
          detail,
        ],
      ),
    );
    throw new Error("webhook delivery failed");
  }
}
export async function consumeWebhooks(
  batch: MessageBatch<DeliveryMessage>,
  env: WebhookEnv,
) {
  for (const message of batch.messages) {
    try {
      if (message.body.kind === "email")
        await deliverAccountEmail(env, message.body.id);
      else await deliver(env, message.body.id);
      message.ack();
    } catch {
      message.retry({ delaySeconds: 30 });
    }
  }
}

/** Account-mail envelopes share the durable PG command inbox; plaintext links are never logged. */
export async function deliverAccountEmail(env: WebhookEnv, id: string) {
  const row = (
    await withSql(env, (sql) =>
      sql.query(
        "select body from idempotency_keys where key=$1 and status=102",
        [`workers:email:${id}`],
      ),
    )
  ).rows[0];
  if (!row) return;
  if (env.TEST_MODE !== "1") {
    if (!env.MAIL || !env.ACCOUNT_EMAIL_FROM)
      throw new Error("Account mail transport is not configured");
    const payload = JSON.parse(await unseal(JSON.parse(row.body), env));
    await env.MAIL.send({
      from: env.ACCOUNT_EMAIL_FROM,
      to: payload.email,
      subject: "Verify your camelRun account email",
      text: `Your one-time verification code is ${payload.token}. It expires in one hour.`,
    });
  }
  await withSql(env, (sql) =>
    sql.query(
      "update idempotency_keys set status=200 where key=$1 and status=102",
      [`workers:email:${id}`],
    ),
  );
}
