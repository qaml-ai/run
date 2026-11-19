import { timingSafeEqual } from "node:crypto";
import { FRAME_BYTES, type RequestRecord } from "../../../shared/client-protocol.ts";
import { expired, hash, REQUEST_METHODS, validId } from "../../../src/v1-client-state.ts";
import { HttpError } from "../../../src/core/http-error.ts";
import { compatibilityEventsResponse } from "../../../src/v1-compatibility-events.ts";
import { compatibilityHistory } from "../../../src/v1-compatibility-history.ts";
import { PromptInput } from "../../../src/v1-prompt-schema.ts";
import { unsupportedV1Operation, V1Compatibility } from "../../../src/v1-v2-compatibility.ts";
import { readText } from "./account-http.ts";
import { readableFrame, readableMessage, readableRequest, type BrowserClaims } from "./browser-tokens.ts";
import { database, type PostgresEnv, type Sql } from "./postgres.ts";

export interface LegacyCompatibilityEnv extends PostgresEnv {
  AGENT_V2_COMPAT_API_KEYS?: string;
  AGENT_V2_COMPAT_URL?: string;
  CAMELRUN_V2_COMPAT?: Fetcher;
}

type Tenant = { tenantId: string; kind: string };
const tenantPaths = /^\/v1\/agents\/(client_[a-f0-9]{40})\/(prompt|mounts|events|state|history|requests\/[^/]+)$/;
const agentPaths = /^\/clients\/(client_[a-f0-9]{40})\/(requests(?:\/[^/]+)?|events|state|history)$/;

export function legacyAgentRequest(request: Request) {
  if (request.headers.has("upgrade")) return;
  const url = new URL(request.url);
  const match = agentPaths.exec(url.pathname) ?? tenantPaths.exec(url.pathname);
  if (!match) return;
  const [, agent, operation] = match;
  if (request.method !== (["prompt", "requests"].includes(operation) ? "POST" : "GET")) return;
  const scoped = url.pathname.startsWith("/clients/");
  if (scoped && operation === "events" && url.searchParams.get("watch") !== "1" && url.searchParams.get("poll") !== "1") return;
  return { agent, operation, scoped };
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const unknownAgent = () => new HttpError(404, "Unknown agent");
const archiveUnavailable = () => new HttpError(503, "The agent's v1 request archive is unavailable", "V1_ARCHIVE_UNAVAILABLE");

async function jsonBody(request: Request, limit: number, empty?: string) {
  const text = await readText(request.body, limit);
  try { return JSON.parse(text || empty || ""); }
  catch { throw new HttpError(400, "Invalid JSON"); }
}

async function promptBody(request: Request) {
  const parsed = PromptInput.safeParse(await jsonBody(request, 6 * 1024 * 1024, "{}"));
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
  return parsed.data;
}

async function agentTenant(request: Request, sql: Sql, agent: string) {
  const { rows: [source] } = await sql.query<{
    tenant: string; revoked: boolean; purged: boolean; expires_at: number | null; digest: string | null;
  }>(`select tenant, revoked, purged_at is not null as purged, expires_at, header->>'digest' as digest
      from agents where id = $1`, [agent]);
  if (source?.purged) throw new HttpError(410, "Session expired or revoked");
  const authorization = request.headers.get("authorization");
  if (!source?.digest || !/^[a-f0-9]{64}$/.test(source.digest) || request.headers.has("origin")
    || !authorization?.startsWith("Bearer ") || !timingSafeEqual(Buffer.from(hash(authorization.slice(7)), "hex"), Buffer.from(source.digest, "hex"))) {
    throw new HttpError(401, "Unauthorized");
  }
  if (source.revoked || expired(source.expires_at)) throw new HttpError(410, "Session expired or revoked");
  return source.tenant;
}

/** Runs before the pilot's directory, whose stored agent headers differ from Node's. */
export function legacyCompatibility(
  request: Request,
  env: LegacyCompatibilityEnv,
  principal: Tenant | null,
  browser?: BrowserClaims,
) {
  if (!env.AGENT_V2_COMPAT_API_KEYS || !legacyAgentRequest(request)) return;
  const sql = database(env);
  const service = env.CAMELRUN_V2_COMPAT;
  const upstream: typeof fetch | undefined = service && ((input, init) => service.fetch(input, init));
  const compatibility = V1Compatibility.configured(sql, env.AGENT_V2_COMPAT_API_KEYS, env.AGENT_V2_COMPAT_URL, upstream)!;
  return handleLegacyAgentRequest(request, sql, compatibility, principal, browser);
}

/** Legacy tenant and agent identity use Postgres even when all model work happens on v2. */
export async function handleLegacyAgentRequest(
  request: Request,
  sql: Sql,
  compatibility: V1Compatibility,
  principal: Tenant | null,
  browser?: BrowserClaims,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = legacyAgentRequest(request);
  if (!match) return;
  const { agent, operation, scoped } = match;
  if (browser) {
    const scopes: readonly string[] = browser.scopes;
    if (request.method !== "GET" || !scopes.includes(operation)) throw new HttpError(403, "This browser token does not grant this read");
    if (browser.agent !== agent) return; // The original agent route continues to handle child streams.
  }
  const tenant = scoped ? await agentTenant(request, sql, agent) : browser?.tenant ?? principal?.tenantId;
  if (!tenant || (principal?.kind === "console" && request.headers.has("authorization"))) {
    throw new HttpError(401, "Invalid or missing credentials");
  }

  if (!scoped) {
    const { rows: [source] } = await sql.query<{ mounts: unknown[] | null }>(
      `select header->'mounts' as mounts from agents where id = $1 and tenant = $2 and not revoked
        and (expires_at is null or expires_at > $3) and header->'run' is null`, [agent, tenant, Date.now()],
    );
    if (!source) throw unknownAgent();
    // Mount metadata belongs to the original agent and remains readable while it drains.
    if (operation === "mounts") return json(source.mounts ?? []);
  }

  const signal = request.signal;
  const route = await compatibility.route(tenant, agent, request.method === "POST" ? signal : undefined);
  if (!route) return;
  async function archived(id: string): Promise<RequestRecord | undefined> {
    const { rows: [row] } = await sql.query<{ receipt: RequestRecord | null }>(
      `select (select value from jsonb_array_elements(receipts) where value->>'id' = $3) as receipt
        from agent_v2_receipt_archives where tenant = $1 and agent = $2`, [tenant, agent, id],
    );
    if (!row) throw archiveUnavailable();
    return row.receipt ?? undefined;
  }
  if (operation === "prompt") {
    const body = await promptBody(request);
    if (body.endUser !== undefined && !["api", "operator"].includes(principal?.kind ?? "")) {
      throw new HttpError(403, "Only a tenant key can choose a run payer");
    }
    const id = body.requestId ?? request.headers.get("idempotency-key") ?? crypto.randomUUID();
    return json(await compatibility.prompt(route, id, body, archived, signal), 202);
  }
  if (operation === "requests") {
    const body = await jsonBody(request, FRAME_BYTES);
    if (!validId(body?.id) || !REQUEST_METHODS.includes(body.method) || !body.params || typeof body.params !== "object" || Array.isArray(body.params)) {
      throw new HttpError(400, "Invalid request");
    }
    if (body.method !== "prompt" || Object.keys(body.params).some(key => !["text", "actor"].includes(key))) throw unsupportedV1Operation();
    const { text, actor } = body.params;
    if (typeof text !== "string" || !text.trim() || (actor !== undefined && typeof actor !== "string")) throw new HttpError(400, "Invalid prompt");
    return json(await compatibility.prompt(route, body.id, { text, actor }, archived, signal), 202);
  }
  if (operation === "events") return compatibilityEventsResponse(request, compatibility, route, browser && {
    show: event => readableFrame(browser, event),
    until: browser.exp,
  });
  if (operation === "state") {
    const requests = sql.query<{ receipts: RequestRecord[] }>(
      "select receipts from agent_v2_receipt_archives where tenant = $1 and agent = $2", [tenant, agent],
    ).then(({ rows: [row] }) => {
      if (!row) throw archiveUnavailable();
      return row.receipts;
    });
    const state = await compatibility.state(route, requests, signal);
    return json(browser ? readableMessage(browser, { ...state, requests: state.requests.map(readableRequest) }) : state);
  }
  if (operation === "history") {
    const query = {
      after: url.searchParams.get("after") ?? undefined,
      before: url.searchParams.get("before") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      maxBytes: url.searchParams.get("maxBytes") ?? undefined,
    };
    const history = await compatibilityHistory(compatibility, route, query, signal);
    return json(browser ? readableMessage(browser, history) : history);
  }
  const id = decodeURIComponent(operation.slice("requests/".length));
  return json(await compatibility.requestFor(route, id, url.searchParams.get("wait") ?? undefined, archived, signal));
}
