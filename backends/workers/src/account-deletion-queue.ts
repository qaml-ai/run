import type { AccountDeletions } from "./account-deletion.ts";
import type { DeliveryMessage } from "./webhooks.ts";

type DeletionQueue = { WEBHOOKS?: Queue<DeliveryMessage> };

export async function enqueueAccountDeletion(env: DeletionQueue, tenant: string, delaySeconds = 0) {
  if (!env.WEBHOOKS) throw new Error("Account deletion queue is not configured");
  await env.WEBHOOKS.send({ kind: "account_deletion", id: tenant }, { delaySeconds });
}

/** Acknowledge only after a continuation is durable; duplicate delivery is safe under the SQL lease. */
export async function consumeAccountDeletion(env: DeletionQueue, deletions: Pick<AccountDeletions, "next" | "retryAfter">, message: Pick<Message<DeliveryMessage>, "body" | "ack">) {
  await deletions.next(message.body.id);
  const delay = await deletions.retryAfter(message.body.id);
  if (delay !== undefined) await enqueueAccountDeletion(env, message.body.id, delay);
  message.ack();
}
