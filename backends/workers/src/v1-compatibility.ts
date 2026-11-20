import { timingSafeEqual } from "node:crypto";
import { FRAME_BYTES, type RequestRecord } from "../../../shared/client-protocol.ts";
import { expired, hash, REQUEST_METHODS, resumeId, validId, type ArchivedV1Input } from "../../../src/v1-client-state.ts";
import { HttpError } from "../../../src/core/http-error.ts";
import { canonical } from "../../../shared/durable-json.ts";
import { answerInput, mayAnswer, settledAlready, Inputs, type Input, type Responder } from "./decision-inputs.ts";
import { answerList } from "./input-policy.ts";
import { actorInput } from "./security-policy.ts";
import { senderInput } from "./sender.ts";
import { compatibilityEventsResponse } from "../../../src/v1-compatibility-events.ts";
import { compatibilityHistory } from "../../../src/v1-compatibility-history.ts";
import { PromptInput } from "../../../src/v1-prompt-schema.ts";
import { unsupportedV1Operation, type CompatibilitySql, type V1Compatibility } from "../../../src/v1-v2-compatibility.ts";
import { readText } from "./account-http.ts";
import { readableFrame, readableMessage, readableRequest, type BrowserClaims } from "./browser-tokens.ts";
import { AgentHistory, historyPageInput } from "../../../src/history-pages.ts";
import type { Db } from "./postgres.ts";
import { listAgentPage, agentListQuery } from "../../../src/agent-directory-page.ts";

const tenantPaths = /^\/v1\/agents\/(client_[a-f0-9]{40})\/(prompt|mounts|events|state|history|inputs(?:\/[^/]+)?|requests\/[^/]+)$/;
const agentPaths = /^\/clients\/(client_[a-f0-9]{40})\/(requests(?:\/[^/]+)?|events|state|history|inputs(?:\/[^/]+)?)$/;
const agentDetail = /^\/v1\/agents\/(client_[a-f0-9]{40})$/;

export function legacyAgentRequest(request: Request) {
  if (request.headers.has("upgrade")) return;
  const url = new URL(request.url);
  const detail = request.method === "GET" ? agentDetail.exec(url.pathname) : undefined;
  if (detail) return { agent: detail[1], operation: "detail", scoped: false };
  const match = agentPaths.exec(url.pathname) ?? tenantPaths.exec(url.pathname);
  if (!match) return;
  const [, agent, operation] = match;
  if (operation === "inputs" ? !["GET", "POST"].includes(request.method)
    : request.method !== (["prompt", "requests"].includes(operation) || operation.startsWith("inputs/") ? "POST" : "GET")) return;
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

async function agentTenant(request: Request, sql: CompatibilitySql, agent: string) {
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

/** Legacy tenant and agent identity use Postgres even when all model work happens on v2. */
export async function handleLegacyAgentRequest(
  request: Request,
  sql: Db,
  compatibility: V1Compatibility,
  principal: { tenantId: string; kind: string } | null,
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
      `select header->'mounts' as mounts from agents where id = $1 and tenant = $2 and not revoked and purged_at is null
        and (expires_at is null or expires_at > $3) and header->'run' is null`, [agent, tenant, Date.now()],
    );
    if (!source) throw unknownAgent();
    // Mount metadata belongs to the original agent and remains readable while it drains.
    if (operation === "mounts") return json(source.mounts ?? []);
  }

  const signal = request.signal;
  const route = await compatibility.route(tenant, agent, request.method === "POST" ? signal : undefined);
  if (!route) {
    if (request.method !== "GET") return;
    if (operation === "inputs") {
      const state = url.searchParams.get("state");
      if (!scoped && state !== null && !inputStates.has(state)) throw new HttpError(400, "Invalid input state");
      const inputs = await new Inputs({ db: sql }).list(tenant, { agent, state: state ?? undefined });
      return json(browser ? readableMessage(browser, inputs) : inputs);
    }
    if (operation === "history") {
      const history = new AgentHistory(sql, true);
      const query = {
        before: url.searchParams.get("before") ?? undefined,
        after: url.searchParams.get("after") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
        maxBytes: url.searchParams.get("maxBytes") ?? undefined,
      };
      const bounds = historyPageInput(query);
      const value = Object.values(query).every(value => value === undefined)
        ? { messages: await history.messages(agent, 0, undefined, 16 * 1024 * 1024) }
        : bounds.after !== undefined ? await history.pageAfter(agent, { ...bounds, after: bounds.after }) : await history.page(agent, bounds);
      return json(browser ? readableMessage(browser, value) : value);
    }
    if (operation !== "detail") return;
  }
  if (operation === "detail") {
    if (url.searchParams.get("refresh") === "true") throw unsupportedV1Operation();
    const [{ agents }, current] = await Promise.all([
      listAgentPage(sql, tenant, agentListQuery(new URLSearchParams({ id: agent }))),
      route && compatibility.detail(route, signal),
    ]);
    if (!agents[0]) throw unknownAgent();
    if (!current) return json(agents[0]);
    const tools = (current.tools ?? []).map(({ name, description, parameters }) =>
      ({ name, description: description ?? "", ...(parameters ? { parameters } : {}) }));
    const mcpServers = (current.mcpServers ?? []).map(({ name }) => ({ name }));
    const schemas = url.searchParams.get("schemas") === "true";
    const toolSources = [
      ...(tools.length ? [{ kind: "application", name: "application", status: "listed", tools: tools.map(({ parameters, ...tool }) =>
        ({ ...tool, ...(schemas && parameters ? { parameters } : {}) })) }] : []),
      ...mcpServers.map(({ name }) => ({ kind: "mcp", name, status: "unlisted", tools: [] })),
    ];
    return json({ ...agents[0], model: current.model, running: current.status === "running", systemPrompt: current.instructions ?? "",
      builtins: current.builtins ?? [], tools, mcpServers, toolSources });
  }
  if (!route) return;
  async function archived(id: string): Promise<RequestRecord | undefined> {
    const { rows: [row] } = await sql.query<{ receipt: RequestRecord | null }>(
      `select (select value from jsonb_array_elements(receipts) where value->>'id' = $3) as receipt
        from agent_v2_receipt_archives where tenant = $1 and agent = $2`, [tenant, agent, id],
    );
    if (!row) throw archiveUnavailable();
    return row.receipt ?? undefined;
  }
  if (operation === "inputs" || operation.startsWith("inputs/")) {
    return historicalInputs(request, sql, tenant, agent, operation, scoped, browser);
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

const inputStates = new Set(["pending", "answered", "declined", "cancelled", "expired", "superseded", "withdrawn"]);

async function historicalInputs(
  request: Request, sql: CompatibilitySql, tenant: string, agent: string,
  operation: string, scoped: boolean, browser?: BrowserClaims,
) {
  const { rows: [archive] } = await sql.query<{ inputs: ArchivedV1Input<Input>[]; receipts: RequestRecord[] }>(
    "select inputs, receipts from agent_v2_receipt_archives where tenant = $1 and agent = $2", [tenant, agent],
  );
  if (!archive) throw archiveUnavailable();
  if (request.method === "GET") {
    const state = new URL(request.url).searchParams.get("state");
    if (!scoped && state !== null && !inputStates.has(state)) throw new HttpError(400, "Invalid input state");
    const inputs = archive.inputs.map(entry => entry.input).filter(input => !state || input.state === state)
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id)).slice(0, 100);
    return json(browser ? readableMessage(browser, inputs) : inputs);
  }

  const via: Responder["via"] = scoped ? "agent" : "api";
  const inputId = operation.startsWith("inputs/") ? decodeURIComponent(operation.slice("inputs/".length)) : undefined;
  const body = await jsonBody(request, (inputId ? 256 : 1024) * 1024, scoped ? undefined : "{}");
  const answers: { id: string; body: any }[] = inputId ? [{ id: inputId, body }] : answerList(body);
  if (!answers.length || answers.length > 100 || new Set(answers.map(answer => answer.id)).size !== answers.length) {
    throw new HttpError(400, "Answer 1 to 100 different inputs");
  }
  const byId = new Map(archive.inputs.map(entry => [entry.input.id, entry]));
  const checked = answers.map(({ id, body }) => {
    const entry = byId.get(id);
    if (!entry) throw new HttpError(404, `Unknown input ${id}`);
    const { input, approvers } = entry;
    const by = { via, from: senderInput(body?.from), actor: actorInput(body?.actor) };
    if (!mayAnswer(input, by, approvers)) throw new HttpError(403, "This person may not answer this input");
    const answer = answerInput(input, body);
    return { input, same: input.state !== "pending" && input.answer && !input.answer.by.system
      && input.answer.action === answer.action && canonical(input.answer.content ?? null) === canonical(answer.content ?? null) };
  });
  const inputs = checked.map(answer => answer.input);
  if (checked.some(answer => !answer.same)) {
    const expired = inputs.find(input => input.answer?.by.system === "expired");
    throw new HttpError(409, inputs.length === 1 ? settledAlready(inputs[0])
      : expired ? settledAlready(expired) : "An input is already settled", undefined,
      { input: inputs.length === 1 ? inputs[0] : inputs });
  }
  const requests = [...new Set(inputs.filter(input => input.blocking !== false).map(input => input.requestId))].map(suspension => {
    const receipt = archive.receipts.find(record => record.id === resumeId(suspension));
    if (!receipt || receipt.method !== "resume" || receipt.suspension !== suspension || receipt.state !== "completed") throw archiveUnavailable();
    return receipt;
  });
  return json(inputId ? { input: inputs[0], request: requests[0] ?? null } : { inputs, requests });
}
