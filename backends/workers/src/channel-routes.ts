import { RETIRED_CHANNEL_MESSAGE, RETIRED_CHANNEL_TYPES } from "../../../src/core/channels/channels.ts";
import { HttpError } from "./errors.ts";
import type { Env } from "./agent-types.ts";
import { ChannelEventsQuery, ChannelInput, ChannelUpdate } from "./channel-inputs.ts";
import { workerChannels } from "./channels.ts";

/**
 * The channel API, as src/channels-api.ts answers it on ECS: /v1/channels (credentials go in and
 * never come out) and the public webhooks, `POST /channels/:type/:id`, each proven by the
 * channel's secret or the service's signature.
 */

const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

/** A shared error (src/core/http-error.ts) as this backend answers errors. */
function answerable(error: unknown): never {
  const failure = error as { status?: unknown; message?: string; code?: unknown; details?: Record<string, unknown> };
  if (typeof failure?.status === "number" && failure.status >= 400 && failure.status < 600 && error instanceof Error)
    throw new HttpError(failure.status, failure.message ?? "Request failed", typeof failure.code === "string" ? failure.code : undefined, failure.details);
  throw error;
}

/** A request body, at most `limit` bytes; past it 413. */
async function text(request: Request, limit: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (request.body) for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    if (bytes > limit) throw new HttpError(413, "Request too large");
    chunks.push(chunk);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(all);
}

async function parse<T extends typeof ChannelInput | typeof ChannelUpdate>(type: T, request: Request) {
  const raw = await text(request, 512 * 1024);
  let input: unknown = {};
  if (raw) {
    try { input = JSON.parse(raw); } catch { throw new HttpError(400, "Invalid JSON"); }
  }
  // A retired type is told where it went, not that it is not in the list.
  const kind = (input as { type?: unknown } | null)?.type;
  if (type === ChannelInput && typeof kind === "string" && RETIRED_CHANNEL_TYPES.has(kind)) throw new HttpError(400, RETIRED_CHANNEL_MESSAGE, "CHANNEL_TYPE_RETIRED");
  const result = type.safeParse(input);
  if (!result.success) throw new HttpError(400, `${result.error.issues[0]!.path.join(".") || "body"}: ${result.error.issues[0]!.message}`);
  return result.data;
}

/** `/v1/channels` and below, for an authenticated tenant; undefined for other paths. */
export async function channelRoutes(request: Request, env: Env, tenant: string, ctx: ExecutionContext): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  const match = /^\/v1\/channels(?:\/([^/]+)(?:\/(events)(?:\/([^/]+)\/(deliver))?)?)?$/.exec(path);
  if (!match) return undefined;
  const [, id, events, event, deliver] = match;
  const method = request.method;
  const route = !id ? (method === "GET" || method === "POST")
    : !events ? ["GET", "PATCH", "DELETE"].includes(method)
    : !event ? method === "GET" : method === "POST" && !!deliver;
  if (!route) return undefined;
  try {
    const channels = await workerChannels(env, work => ctx.waitUntil(work));
    if (!id) return method === "GET" ? reply(await channels.list(tenant)) : reply(await channels.create(tenant, await parse(ChannelInput, request)), 201);
    const channel = decodeURIComponent(id);
    if (events && event) return reply(await channels.deliverEvent(tenant, channel, decodeURIComponent(event)));
    if (events) {
      const query = ChannelEventsQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!query.success) throw new HttpError(400, `${query.error.issues[0]!.path.join(".") || "query"}: ${query.error.issues[0]!.message}`);
      return reply(await channels.events(tenant, channel, query.data));
    }
    if (method === "GET") return reply(await channels.get(tenant, channel));
    if (method === "PATCH") return reply(await channels.update(tenant, channel, await parse(ChannelUpdate, request)));
    await channels.remove(tenant, channel);
    return reply({ deleted: true });
  } catch (error) { return answerable(error); }
}

/** A service's delivery to a channel's public webhook; undefined for other paths. */
export async function channelWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | undefined> {
  const match = /^\/channels\/([^/]+)\/([^/]+)$/.exec(new URL(request.url).pathname);
  if (!match || request.method !== "POST") return undefined;
  try {
    const channels = await workerChannels(env, work => ctx.waitUntil(work));
    const answer = await channels.webhook(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!), request.headers, max => text(request, max));
    return answer.json ? Response.json(answer.json, { status: answer.status }) : new Response(null, { status: answer.status });
  } catch (error) { return answerable(error); }
}
