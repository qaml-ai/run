import { Directory, type AuthContext, type ControlEnv, type DirectoryEntry, type DirectoryFailure } from "./control.ts";
import { agentToken, ApiError, digest } from "./api-contract.ts";
import { body, object } from "./validation.ts";
import { withSql } from "./postgres.ts";
import { copyAgentWorkspace } from "./agent-workspace.ts";
import type { FileBindings } from "./files.ts";
import { provisionDefinition, visibleConfiguration } from "./definitions.ts";
import { canonical } from "../../../shared/durable-json.ts";

type Record = { id: string; state: string; outcome?: { result?: any; error?: string; uncertain?: boolean }; metadata?: unknown; startedAt?: number; began?: number; endedAt?: number };
type RunInfo = { fingerprint: string; retentionMs: number };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
function result(value: DirectoryEntry | DirectoryFailure): DirectoryEntry { if ("failed" in value) throw new ApiError(value.status, value.error, value.code); return value; }
async function call(env: ControlEnv, id: string, path: string, input?: unknown): Promise<Response> {
  return env.AGENTS.getByName(id).fetch(new Request(`https://agent${path}`, input === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }));
}
async function payload(response: Response) { const value = await response.json() as any; if (!response.ok) throw new ApiError(response.status, value.error ?? "Agent operation failed", value.code); return value; }
export function runView(record: Record, retentionMs: number) {
  const result = record.outcome?.result ?? {}, ended = record.state === "completed";
  const error = !ended ? null : record.outcome?.error ? { code: /aborted/i.test(record.outcome.error) ? "aborted" : "runtime_error", message: record.outcome.error } : result.error ? { code: result.code ?? "model_error", message: result.error, ...result.modelError } : null;
  return { id: record.id, status: !ended ? "running" : error ? "failed" : result.stopped === "input_required" ? "input_required" : "completed", text: result.reply ?? "", ...(result.output !== undefined ? { output: result.output } : {}), error, usage: result.usage ?? null, ...(result.servedModel ? { servedModel: result.servedModel } : {}), toolCalls: result.toolCalls ?? [], toolErrors: result.toolErrors ?? [], sourceErrors: result.sourceErrors ?? [], files: result.files ?? [], ...(record.metadata ? { metadata: record.metadata } : {}), createdAt: record.startedAt, startedAt: record.began, endedAt: record.endedAt, expiresAt: ended && record.endedAt ? record.endedAt + retentionMs : null };
}

export async function statelessRoutes(request: Request, env: ControlEnv, auth: AuthContext): Promise<Response | undefined> {
  const url = new URL(request.url), match = /^\/v1\/runs(?:\/(run_[a-f0-9]{40})(\/events|\/messages|\/abort)?)?$/.exec(url.pathname);
  if (!match) return;
  const directory = new Directory(env, auth.tenantId);
  let entry: DirectoryEntry & { run?: RunInfo };
  let runId = match[1];
  if (!runId && request.method === "POST") {
    const raw = await body(request, 7 * 1024 * 1024) as {[key:string]:any};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "Expected run configuration");
    const { input, wait, retentionSeconds = 86400, output, actor, from, metadata, ...given } = raw;
    const parts = typeof input === "string" ? [{ type: "text", text: input }] : input;
    if (!Array.isArray(parts) || !parts.length || parts.some((part:any) => part.type !== "text" || typeof part.text !== "string")) throw new ApiError(400, "Run input must contain text; upload files to a volume first");
    const text = parts.map((part:any) => part.text).join("\n\n");
    if (!text.trim()) throw new ApiError(400, "Run input must be nonempty");
    if (!Number.isInteger(retentionSeconds) || retentionSeconds < 60 || retentionSeconds > 604800) throw new ApiError(400, "Invalid retentionSeconds");
    const key = request.headers.get("Idempotency-Key"), hash = await digest(key ?? crypto.randomUUID());
    const directoryKey = `run-${hash.slice(0, 40)}`;
    const fingerprint = await digest(canonical(JSON.parse(JSON.stringify({ input, retentionSeconds, output, actor, from, metadata, ...given }))));
    const old = await directory.get(directoryKey) as typeof entry | null;
    if (old?.run && old.run.fingerprint !== fingerprint) throw new ApiError(409, "Idempotency-Key was used for a different run", "IDEMPOTENCY_CONFLICT");
    if (old) entry = old;
    else {
      const noTools = !given.definition && !given.builtins?.length && !given.delegate && !given.mcpServers?.length && !given.fileTools && !given.mounts?.length;
      const config = await provisionDefinition(env, auth.tenantId, { ...(noTools ? { codeMode:false, fileTools:false, decide:false } : {}), ...given, type: "run", ttlSeconds: 604800 + retentionSeconds });
      entry = result(await directory.upsert(config, directoryKey));
    }
    if (entry.config.type !== "run") throw new ApiError(409, "Key belongs to an agent", "IDEMPOTENCY_CONFLICT");
    if (!entry.run) {
      const run = { fingerprint, retentionMs: retentionSeconds * 1000 };
      const saved = await withSql(env, sql => sql.query("update agents set header=jsonb_set(header::jsonb,'{run}',$3::jsonb)::json where tenant=$1 and id=$2 and (header->'run' is null or header->'run'->>'fingerprint'=$4) returning header", [auth.tenantId, entry.id, JSON.stringify(run), fingerprint]));
      if (!saved.rows.length) throw new ApiError(409, "Idempotency-Key was used for a different run", "IDEMPOTENCY_CONFLICT");
      entry = saved.rows[0].header;
    }
    runId = `run_${entry.id.slice("client_".length)}`;
    let record = await payload(await call(env, entry.id, "/requests", { id: runId, method:"prompt", params: { text, allowDisconnected:true, ...(output ? {output} : {}), ...(actor ? {actor} : {}), ...(from ? {from} : {}), ...(metadata ? {metadata} : {}) } })) as Record;
    const seconds = url.searchParams.get("wait") ?? (wait === true ? 60 : wait === false || wait === undefined ? 0 : Number(wait));
    if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) throw new ApiError(400, "Invalid wait");
    if (Number(seconds) > 0 && record.state !== "completed") record = await payload(await call(env, entry.id, `/requests/${runId}?wait=${Math.min(60,Number(seconds))}`));
    return json(runView(record, entry.run!.retentionMs), record.state === "completed" ? 200 : 202);
  }
  if (!runId) throw new ApiError(405, "Method not allowed");
  entry = await directory.get(`client_${runId.slice(4)}`) as typeof entry;
  if (!entry || !entry.run || entry.deleted) throw new ApiError(404, "Unknown run", "NOT_FOUND");
  const record = await payload(await call(env, entry.id, `/requests/${runId}?wait=${Math.min(25,Number(url.searchParams.get("wait") ?? 0))}`)) as Record;
  if (record.endedAt && record.endedAt + entry.run.retentionMs <= Date.now()) throw new ApiError(404, "Run retention expired", "NOT_FOUND");
  if (match[2] === "/events" && request.method === "GET") return call(env, entry.id, "/events");
  if (match[2] === "/messages" && request.method === "GET") { const history = await payload(await call(env, entry.id, "/history")); return json(history.messages.filter((message: {role:string}) => message.role !== "system")); }
  if (match[2] === "/abort" && request.method === "POST") return call(env, entry.id, "/abort", {});
  if (!match[2] && request.method === "DELETE") { await directory.remove(entry.id); return json({deleted:true}); }
  if (!match[2] && request.method === "GET") return json(runView(record, entry.run.retentionMs));
  throw new ApiError(405, "Method not allowed");
}

export async function agentLifecycleRoutes(request: Request, env: ControlEnv & FileBindings, entry: DirectoryEntry, tail: string): Promise<Response | undefined> {
  if (tail === "/export" && request.method === "GET") return json({ config: visibleConfiguration(entry.config), ...(await payload(await call(env, entry.id, "/history"))) });
  if (tail !== "/fork" || request.method !== "POST") return;
  const input = object(await body(request), ["key", "name", "atMessage", "ttlSeconds", "subject", "context", "systemPromptAppend", "modelHeaders"]);
  const key = input.key ?? request.headers.get("Idempotency-Key") ?? undefined;
  if (key !== undefined && typeof key !== "string") throw new ApiError(400, "Invalid fork key");
  const directory = new Directory(env, entry.tenantId), existing = key ? await directory.get(key as string) : null;
  const saved = existing as (DirectoryEntry & { forkedFrom?: {agentId:string;atMessage:number} }) | null;
  if (saved) { if (saved.forkedFrom?.agentId !== entry.id) throw new ApiError(409, "Key belongs to another agent"); return json({id:saved.id,token:await agentToken(env.API_TOKEN,saved.id),expiresAt:saved.expiresAt,forkedFrom:saved.forkedFrom},201); }
  const history = await payload(await call(env, entry.id, "/history"));
  const at = input.atMessage === undefined ? history.messages.length - 1 : Number(input.atMessage);
  if (!Number.isInteger(at) || at < -1 || at >= history.messages.length) throw new ApiError(400, "Invalid fork point");
  const initialMessages = history.messages.slice(0, at + 1);
  const { key: _key, atMessage: _at, ...settings } = input;
  const created = result(await directory.upsert({ ...entry.config, ...settings, initialMessages, ttlSeconds: input.ttlSeconds === undefined ? (key ? null : 86400) : input.ttlSeconds }, key as string | undefined));
  await copyAgentWorkspace(env, entry.tenantId, entry.id, created.id);
  const forkedFrom = {agentId:entry.id,atMessage:at};
  await withSql(env, sql => sql.query("update agents set header=$3 where tenant=$1 and id=$2", [entry.tenantId,created.id,JSON.stringify({...created,forkedFrom})]));
  return json({id:created.id,token:await agentToken(env.API_TOKEN,created.id),expiresAt:created.expiresAt,forkedFrom},201);
}
