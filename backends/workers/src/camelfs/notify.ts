import { createHmac, timingSafeEqual } from "node:crypto";
import type { Env } from "../agent.ts";
import type { WorkflowEnv } from "../workflow-object.ts";

export type NotifyEnv = Env & Pick<WorkflowEnv, "WORKFLOWS"> & { CAMELFS_NOTIFY_KEY?: string };
type Delivery = { id: string; type: string; body: Record<string, unknown> };
type Handler = (env: NotifyEnv, delivery: Delivery) => Promise<void>;
const handlers = new Map<string, Handler>();

export function registerNotifyHandler(type: string, handler: Handler) {
  if (handlers.has(type)) throw new Error(`Duplicate camelFS notification handler for ${type}`);
  handlers.set(type, handler);
}

export type RefMove = {
  id: string; lineage: string; ref: string; from: string | null; to: string; tree: string;
  by: string; at: number;
};

class InvalidDelivery extends Error {}

registerNotifyHandler("ref.moved", async (env, { id, body }) => {
  const { lineage, ref, from, to, tree, by, at, watchers } = body;
  if (typeof lineage !== "string" || typeof ref !== "string" || (from !== null && typeof from !== "string") ||
      typeof to !== "string" || typeof tree !== "string" || typeof by !== "string" || typeof at !== "number" ||
      !Array.isArray(watchers) || watchers.some(w => typeof w !== "string" || !/^(agent|workflow):.+$/.test(w)))
    throw new InvalidDelivery();
  const move = { id, lineage, ref, from, to, tree, by, at };
  await Promise.all([...new Set<string>(watchers)].map(watcher => watcher.startsWith("agent:")
    ? env.AGENTS.getByName(watcher.slice(6)).stageRepoMove(move)
    : env.WORKFLOWS.getByName(watcher.slice(9)).stageRepoMove(move)));
});

export async function handleCamelfsNotify(request: Request, env: NotifyEnv, now = Date.now()) {
  if (request.method !== "POST" || !env.CAMELFS_NOTIFY_KEY) return new Response(null, { status: 404 });
  const signature = /^t=(\d{1,16}),v1=([\da-f]{64})$/i.exec(request.headers.get("Camel-Signature") ?? "");
  const unauthorized = () => new Response(null, { status: 401 });
  if (!signature) return unauthorized();
  const timestamp = Number(signature[1]) * 1000;
  if (timestamp < now - 300_000 || timestamp > now + 5_000) return unauthorized();
  const bytes = Buffer.from(await request.arrayBuffer());
  const expected = createHmac("sha256", env.CAMELFS_NOTIFY_KEY).update(signature[1] + ".").update(bytes).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature[2], "hex"))) return unauthorized();

  let body: Record<string, unknown>;
  try { body = JSON.parse(bytes.toString("utf8")); }
  catch { return new Response(null, { status: 400 }); }
  if (!body || typeof body.id !== "string" || !body.id || typeof body.type !== "string")
    return new Response(null, { status: 400 });
  const handler = handlers.get(body.type);
  if (!handler) return new Response(null, { status: 400 });
  try { await handler(env, { id: body.id, type: body.type, body }); }
  catch (e) { if (e instanceof InvalidDelivery) return new Response(null, { status: 400 }); throw e; }
  return new Response(null, { status: 204 });
}

const prefix = "camelfs:move:";
export async function stageRepoMove(storage: DurableObjectStorage, move: RefMove) {
  await storage.transaction(async tx => {
    const key = prefix + move.id;
    if (await tx.get(key) !== undefined || await tx.get("camelfs:seen:" + move.id)) return;
    await tx.put(key, move);
    const at = Date.now() + 1000, alarm = await tx.getAlarm();
    if (alarm === null || alarm > at) await tx.setAlarm(at);
  });
}

export async function repoMoveDeadline(storage: DurableObjectStorage) {
  return (await storage.list({ prefix, limit: 1 })).size ? Date.now() + 1000 : undefined;
}

export async function drainRepoMoves(storage: DurableObjectStorage, deliver: (moves: RefMove[]) => Promise<void>) {
  const pending = await storage.list<RefMove>({ prefix, limit: 100 });
  if (!pending.size) return;
  await deliver([...pending.values()]);
  await storage.transaction(async tx => {
    for (const [key, move] of pending) {
      await tx.put("camelfs:seen:" + move.id, true);
      await tx.delete(key);
    }
  });
}
