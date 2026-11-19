import { Hono } from "hono";
import type { RequestRecord } from "../../../shared/client-protocol.ts";
import { HttpError } from "../../../src/core/http-error.ts";
import { compatibilityEvents } from "../../../src/v1-compatibility-events.ts";
import { compatibilityHistory } from "../../../src/v1-compatibility-history.ts";
import { PromptInput } from "../../../src/v1-prompt-schema.ts";
import { V1Compatibility, type MigratedAgent } from "../../../src/v1-v2-compatibility.ts";
import { readText } from "./account-http.ts";
import { readableFrame, readableMessage, readableRequest, type BrowserClaims } from "./browser-tokens.ts";
import { database, type PostgresEnv, type Sql } from "./postgres.ts";

export interface LegacyCompatibilityEnv extends PostgresEnv {
  AGENT_V2_COMPAT_API_KEYS?: string;
  AGENT_V2_COMPAT_URL?: string;
  CAMELRUN_V2_COMPAT?: Fetcher;
}

type Tenant = { tenantId: string; kind: string };
const paths = /^\/v1\/agents\/(client_[a-f0-9]{40})\/(prompt|mounts|events|state|history|requests\/[^/]+)$/;

export function legacyAgentRequest(request: Request) {
  const match = paths.exec(new URL(request.url).pathname);
  if (match && request.method === (match[2] === "prompt" ? "POST" : "GET") && !request.headers.has("upgrade")) return match;
}

const events = new Hono<{ Bindings: { compatibility: V1Compatibility; route: MigratedAgent; browser?: BrowserClaims } }>();
events.onError(error => { throw error; });
events.get("*", c => {
  const { compatibility, route, browser } = c.env;
  return compatibilityEvents(c, compatibility, route, browser && {
    show: event => readableFrame(browser, event),
    until: browser.exp,
  });
});

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const unknownAgent = () => new HttpError(404, "Unknown agent");
const archiveUnavailable = () => new HttpError(503, "The agent's v1 request archive is unavailable", "V1_ARCHIVE_UNAVAILABLE");

async function promptBody(request: Request) {
  const text = await readText(request.body, 6 * 1024 * 1024);
  let data: unknown;
  try { data = JSON.parse(text || "{}"); }
  catch { throw new HttpError(400, "Invalid JSON"); }
  const parsed = PromptInput.safeParse(data);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
  return parsed.data;
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
  const [, agent, operation] = match;
  if (browser) {
    const scopes: readonly string[] = browser.scopes;
    if (request.method !== "GET" || !scopes.includes(operation)) throw new HttpError(403, "This browser token does not grant this read");
    if (browser.agent !== agent) return; // The original agent route continues to handle child streams.
  }
  const tenant = browser?.tenant ?? principal?.tenantId;
  if (!tenant || (principal?.kind === "console" && request.headers.has("authorization"))) {
    throw new HttpError(401, "Invalid or missing credentials");
  }

  const { rows: [source] } = await sql.query<{ mounts: unknown[] | null }>(
    `select header->'mounts' as mounts from agents where id = $1 and tenant = $2 and not revoked
      and (expires_at is null or expires_at > $3) and header->'run' is null`, [agent, tenant, Date.now()],
  );
  if (!source) throw unknownAgent();
  // Mount metadata belongs to the original agent and remains readable while it drains.
  if (operation === "mounts") return json(source.mounts ?? []);

  const signal = request.signal;
  const route = await compatibility.route(tenant, agent, operation === "prompt" ? signal : undefined);
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
  if (operation === "events") return events.fetch(request, { compatibility, route, browser });
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
