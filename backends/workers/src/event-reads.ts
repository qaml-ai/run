import { createHash } from "node:crypto";
import { HttpError } from "./errors.ts";
import { createTenants, type SecurityEnv } from "./security-services.ts";
import type { TenantAdmission } from "./tenant.ts";

// Like Node's Subscribers, the bound is per serving isolate, shared across all
// agents of a tenant. Closing, aborting, and failing while loading all release it.
const watchers = new Map<string, number>();
const agentWatchers = new Map<string, number>();
const nodeWatchers = new Map<string, number>();
/** Includes the bounded 25-second poll and time to load its agent. */
export const SUBSCRIBER_SETUP_MS = 30_000;
export async function eventRead(request: Request, env: SecurityEnv & { TENANTS: DurableObjectNamespace<TenantAdmission> }, tenant: string, agentId: string, forward: (request: Request) => Promise<Response>, waitUntil: (task: Promise<unknown>) => void): Promise<Response> {
  const url = new URL(request.url);
  const watch = url.searchParams.get("watch") === "1";
  const polling = url.searchParams.get("poll") === "1";
  const requested = url.searchParams.get("request");
  // Hibernating sockets enforce their per-agent bound inside the Durable Object.
  // Only bounded JSON long polls keep a serving-isolate admission slot.
  if (!watch || !polling) return forward(request);
  const tenants = await createTenants(env);
  const limit = tenants.maxWatchers(tenant) ?? 1024;
  const node = createHash("sha256").update(env.HYPERDRIVE.connectionString).digest("hex");
  const key = `${node}:${tenant}`, agent = `${node}:${agentId}`;
  const reject = (scope: string) => { throw Object.assign(new HttpError(429, `This ${scope} has too many event stream subscribers; retry later`), { retryAfter: 5 }); };
  // src/client-sessions/events.ts's per-agent, tenant and node bounds.
  if ((agentWatchers.get(agent) ?? 0) >= 32) reject("agent");
  if ((watchers.get(key) ?? 0) >= limit) reject("tenant");
  if ((nodeWatchers.get(node) ?? 0) >= 4096) reject("node");
  const slot = `poll:${crypto.randomUUID()}`, admission = env.TENANTS.getByName(tenant);
  // Start before the RPC: the durable lease begins before its response reaches
  // us, so delayed admission must not extend the local setup past that lease.
  const setupDeadline = Date.now() + SUBSCRIBER_SETUP_MS;
  if (!await admission.acquireWatcher(agentId, slot, limit)) reject("tenant");
  if (Date.now() >= setupDeadline) {
    await admission.releaseWatcher(slot);
    throw new HttpError(504, "Event subscriber setup timed out; retry later");
  }
  watchers.set(key, (watchers.get(key) ?? 0) + 1);
  agentWatchers.set(agent, (agentWatchers.get(agent) ?? 0) + 1);
  nodeWatchers.set(node, (nodeWatchers.get(node) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const [counts, name] of [[watchers, key], [agentWatchers, agent], [nodeWatchers, node]] as const) {
      const count = (counts.get(name) ?? 1) - 1;
      if (count) counts.set(name, count); else counts.delete(name);
    }
  };
  const controller = new AbortController();
  const abort = () => { release(); controller.abort(request.signal.reason); };
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      release();
      controller.abort();
      reject(new HttpError(504, "Event subscriber setup timed out; retry later"));
    }, Math.max(0, setupDeadline - Date.now()));
  });
  // Race the whole setup, including a stalled body. An upstream that ignores
  // cancellation must not retain an isolate slot or attach after its lease.
  const setup = async () => {
    const response = await forward(new Request(request, { signal: controller.signal }));
    if (controller.signal.aborted) {
      await response.body?.cancel();
      throw new HttpError(504, "Event subscriber setup timed out; retry later");
    }
    if (!response.ok || !response.body || response.status === 101) { release(); return response; }
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    const visible = (frame: any) => !requested || (frame?.type === "event" ? frame.requestId === requested : frame?.type === "response" ? frame.id === requested : true);
    const result = await response.json() as { events: { data: unknown }[] };
    if (requested) result.events = result.events.filter(event => visible(event.data));
    release();
    return Response.json(result, { status: response.status, headers });
  };
  try {
    return await Promise.race([setup(), expired]);
  } catch (error) { release(); throw error; }
  finally {
    clearTimeout(timer!);
    request.signal.removeEventListener("abort", abort);
    await admission.releaseWatcher(slot);
  }
}
