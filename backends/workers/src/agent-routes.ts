import { transcriptDescendants, transcriptScope } from "./session-transcripts.ts";
import { workerDreaming } from "./dreaming.ts";
import { sessionTranscripts } from "../../../shared/session-transcripts.ts";
import { runLog, logOptions, LOG_PAGE_BYTES } from "../../../shared/run-log.ts";
import { Directory, type AuthContext, type ControlEnv, type DirectoryEntry, type DirectoryFailure } from "./control.ts";
import { agentToken, ApiError, configuration, digest } from "./api-contract.ts";
import { body, boundedText, object } from "./validation.ts";
import { withSql } from "./postgres.ts";
import { claimAgentWorkspace, claimFork, copyAgentWorkspace, forkWorkspaceMounts, readForkClaim, releaseForkClaim } from "./agent-workspace.ts";
import { Workspaces } from "./workspaces.ts";
import { database } from "./postgres.ts";
import type { FileBindings } from "./files.ts";
import { provisionDefinition, visibleConfiguration, withoutOnExpire } from "./definitions.ts";
import { canonical } from "../../../shared/durable-json.ts";
import { runInput } from "./run-input.ts";
import { bridgeEvents, bridgeOptions, wantsEventStream } from "./sse-bridge.ts";

type Record = { id: string; state: string; outcome?: { result?: any; error?: string; uncertain?: boolean }; metadata?: unknown; startedAt?: number; began?: number; endedAt?: number };
type RunInfo = { fingerprint: string; retentionMs: number };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
function result(value: DirectoryEntry | DirectoryFailure): DirectoryEntry { if ("failed" in value) throw new ApiError(value.status, value.error, value.code); return value; }
async function call(env: ControlEnv, id: string, path: string, input?: unknown): Promise<Response> {
  return env.AGENTS.getByName(id).fetch(new Request(`https://agent${path}`, input === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }));
}
async function payload(response: Response) {
  const value = await response.json() as any;
  if (!response.ok) {
    const { error, code, ...details } = value;
    throw Object.assign(new ApiError(response.status, error ?? "Agent operation failed", code), {
      details,
      ...(response.headers.has("retry-after") ? { retryAfter: Number(response.headers.get("retry-after")) } : {}),
    });
  }
  return value;
}
export function runView(record: Record, retentionMs: number) {
  const result = record.outcome?.result ?? {}, ended = record.state === "completed";
  const error = !ended ? null : record.outcome?.error ? { code: /aborted/i.test(record.outcome.error) ? "aborted" : "runtime_error", message: record.outcome.error } : result.error ? { code: result.code ?? "model_error", message: result.error, ...result.modelError, ...Object.fromEntries(["limit", "reason", "bucket", "endUser"].flatMap(key => typeof result[key] === "string" ? [[key, result[key]]] : [])) } : null;
  return { id: record.id, status: !ended ? "running" : error ? "failed" : result.stopped === "input_required" ? "input_required" : "completed", ...(result.stopped === "spend_limit" ? { stoppedReason: "budget_reached", limit: result.limit } : {}), text: result.reply ?? "", ...(result.output !== undefined ? { output: result.output } : {}), error, usage: result.usage ?? null, ...(result.servedModel ? { servedModel: result.servedModel } : {}), toolCalls: result.toolCalls ?? [], toolErrors: result.toolErrors ?? [], sourceErrors: result.sourceErrors ?? [], files: result.files ?? [], ...(record.metadata ? { metadata: record.metadata } : {}), createdAt: record.startedAt, startedAt: record.began, endedAt: record.endedAt, expiresAt: ended && record.endedAt ? record.endedAt + retentionMs : null };
}

export async function statelessRoutes(request: Request, env: ControlEnv, auth: AuthContext): Promise<Response | undefined> {
  const url = new URL(request.url), match = /^\/v1\/runs(?:\/(run_[a-f0-9]{40})(\/events|\/messages|\/abort|\/log)?)?$/.exec(url.pathname);
  if (!match) return;
  const directory = new Directory(env, auth.tenantId);
  let entry: DirectoryEntry & { run?: RunInfo };
  let runId = match[1];
  if (!runId && request.method === "POST") {
    const raw = await body(request, 7 * 1024 * 1024) as {[key:string]:any};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "Expected run configuration");
    const { input, files, wait, retentionSeconds: askedRetention, output, actor, from, metadata, spendLimit, ...given } = raw;
    const retentionSeconds = askedRetention ?? Number((env as ControlEnv & { AGENT_RUN_RETENTION_SECONDS?: string }).AGENT_RUN_RETENTION_SECONDS ?? 86400);
    const { text, files: attached } = runInput(input, files);
    if (!Number.isInteger(retentionSeconds) || retentionSeconds < (askedRetention === undefined ? 1 : 60) || retentionSeconds > 604800) throw new ApiError(400, "Invalid retentionSeconds");
    if (given.mcp !== undefined) throw new ApiError(400, "A run uses mcpServers, not attached mcp tools");
    if (given.builtins?.some((name: string) => ["ask_user", "ask_human", "schedule"].includes(name))) throw new ApiError(400, "A run's builtins cannot ask for input or schedule later work");
    const key = request.headers.get("Idempotency-Key"), hash = await digest(key ?? crypto.randomUUID());
    const directoryKey = `run-${hash.slice(0, 40)}`;
    const fingerprint = await digest(canonical(JSON.parse(JSON.stringify({ input, files, retentionSeconds, output, actor, from, metadata, spendLimit, ...given }))));
    const old = await directory.get(directoryKey) as typeof entry | null;
    if (old?.run && old.run.fingerprint !== fingerprint) throw new ApiError(409, "Idempotency-Key was used for a different run", "IDEMPOTENCY_CONFLICT");
    if (old) entry = old.initialized ? old : result(await directory.upsert({...old.config,mounts:undefined}, directoryKey, url.origin));
    else {
      const noTools = !given.definition && !given.builtins?.length && !given.delegate && !given.mcpServers?.length && !given.fileTools && !given.mounts?.length && !attached.length;
      const config = await provisionDefinition(env, auth.tenantId, { ...(noTools ? { codeMode:false, fileTools:false, decide:false } : {}), ...given, type: "run", ttlSeconds: 604800 + retentionSeconds });
      entry = result(await directory.upsert(config, directoryKey, url.origin));
    }
    if (entry.config.type !== "run") throw new ApiError(409, "Key belongs to an agent", "IDEMPOTENCY_CONFLICT");
    if (!entry.run) {
      const run = { fingerprint, retentionMs: retentionSeconds * 1000 };
      const saved = await withSql(env, sql => sql.query("update agents set header=jsonb_set(header::jsonb,'{run}',$3::jsonb)::json where tenant=$1 and id=$2 and (header->'run' is null or header->'run'->>'fingerprint'=$4) returning header", [auth.tenantId, entry.id, JSON.stringify(run), fingerprint]));
      if (!saved.rows.length) throw new ApiError(409, "Idempotency-Key was used for a different run", "IDEMPOTENCY_CONFLICT");
      entry = saved.rows[0].header;
    }
    runId = `run_${entry.id.slice("client_".length)}`;
    let record: Record;
    try {
      record = await payload(await call(env, entry.id, "/requests", { id: runId, method:"prompt", params: { text, allowDisconnected:true, ...(attached.length ? {files: attached} : {}), ...(output ? {output} : {}), ...(spendLimit !== undefined ? {spendLimit} : {}), ...(actor ? {actor} : {}), ...(from ? {from} : {}), ...(metadata ? {metadata} : {}) } })) as Record;
    } catch (error) {
      if (!old) await directory.remove(entry.id);
      throw error;
    }
    const seconds = url.searchParams.get("wait") ?? (wait === true ? 60 : wait === false || wait === undefined ? 0 : Number(wait));
    if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) throw new ApiError(400, "Invalid wait");
    if (Number(seconds) > 0 && record.state !== "completed") record = await payload(await call(env, entry.id, `/requests/${runId}?wait=${Math.min(60,Number(seconds))}`));
    return json(runView(record, entry.run!.retentionMs), record.state === "completed" ? 200 : 202);
  }
  if (!runId) throw new ApiError(405, "Method not allowed");
  entry = await directory.get(`client_${runId.slice(4)}`) as typeof entry;
  if (!entry || !entry.run || entry.deleted) throw new ApiError(404, "Unknown run", "NOT_FOUND");
  if (match[2] === "/messages" && request.method === "GET") return call(env, entry.id, `/history?run=${encodeURIComponent(runId)}&retentionMs=${entry.run.retentionMs}`);
  const record = await payload(await call(env, entry.id, `/requests/${runId}?wait=${Math.min(25,Number(url.searchParams.get("wait") ?? 0))}`)) as Record;
  if (record.endedAt && record.endedAt + entry.run.retentionMs <= Date.now()) throw new ApiError(404, "Run retention expired", "NOT_FOUND");
  if (match[2] === "/log" && request.method === "GET") {
    const options = logOptions(url.searchParams);
    const history = await payload(await call(env, entry.id, `/history?run=${encodeURIComponent(runId)}&retentionMs=${entry.run.retentionMs}&after=${options.after}&limit=${options.limit}&maxBytes=${LOG_PAGE_BYTES}`));
    return json(runLog(runView(record, entry.run.retentionMs), history, options));
  }
  if (match[2] === "/events" && request.method === "GET") {
    const headers = new Headers(request.headers);
    headers.set("x-camel-events-path", url.pathname);
    const target = new URL("https://agent/events");
    target.search = url.search;
    target.searchParams.set("watch", "1");
    target.searchParams.set("runId", runId);
    const agent = env.AGENTS.getByName(entry.id), events = new Request(target, { headers, signal: request.signal });
    return wantsEventStream(events) ? bridgeEvents(events, request => agent.fetch(request), bridgeOptions(env)) : agent.fetch(events);
  }
  if (match[2] === "/abort" && request.method === "POST") return call(env, entry.id, "/abort", {});
  if (!match[2] && request.method === "DELETE") { await directory.remove(entry.id); return json({deleted:true}); }
  if (!match[2] && request.method === "GET") return json(runView(record, entry.run.retentionMs));
  throw new ApiError(405, "Method not allowed");
}

export async function agentLifecycleRoutes(request: Request, env: ControlEnv & FileBindings, entry: DirectoryEntry, tail: string, includeToken = true, background?: (work: Promise<unknown>) => void): Promise<Response | undefined> {
  if (tail === "/dreaming" || tail === "/dreaming/run") {
    const service=workerDreaming(env);
    if(tail === "/dreaming" && request.method === "GET") return json(await service.get(entry.tenantId,entry.id));
    if(tail === "/dreaming" && request.method === "PUT") return json(await service.configure(entry.tenantId,entry.id,await body(request)));
    if(tail === "/dreaming/run" && request.method === "POST") {
      const queued=await service.now(entry.tenantId,entry.id);
      background?.((async()=>{for(let i=0;i<15;i++){await service.scan();await new Promise(resolve=>setTimeout(resolve,1000));}})());
      return json(queued,202);
    }
  }
  if (tail === "/sessions" && request.method === "GET") {
    const q = new URL(request.url).searchParams;
    if (q.has("children") && !["true", "false"].includes(q.get("children")!)) throw new ApiError(400, "Invalid children");
    try { return json(await sessionTranscripts({ descendants: (tenant, root) => transcriptDescendants(env, tenant, root), scope:id=>transcriptScope(env,id), query: (sql, values) => withSql(env, db => db.query(sql, values)), page: async (id, after, limit) => payload(await call(env, id, `/history?after=${after}&limit=${limit}&maxBytes=1000000`)) }, entry.tenantId, entry.id, { from: Number(q.get("from") ?? NaN), to: Number(q.get("to") ?? NaN), cursor: q.get("cursor") ?? undefined, limit: q.has("limit") ? Number(q.get("limit")) : undefined, children: q.get("children") !== "false", endUser:q.get("endUser") ?? undefined })); }
    catch (error) { if ((error as any).status === 400) throw new ApiError(400, (error as Error).message); throw error; }
  }
  if (tail === "/export" && request.method === "GET") return json({ config: visibleConfiguration(entry.config), ...(await payload(await call(env, entry.id, "/history"))) });
  if (tail !== "/fork" || request.method !== "POST") return;
  const input = object(await body(request), ["key", "name", "atMessage", "ttlSeconds", "subject", "context", "systemPromptAppend", "modelHeaders"]);
  const suppliedKey = input.key ?? request.headers.get("Idempotency-Key") ?? undefined;
  if (suppliedKey !== undefined && typeof suppliedKey !== "string") throw new ApiError(400, "Invalid fork key");
  const key = boundedText(suppliedKey ?? crypto.randomUUID(), "Fork key", 80);
  const directory = new Directory(env, entry.tenantId), targetId = await directory.id(key);
  let saved = await directory.get(key) as (DirectoryEntry & { forkedFrom?: { agentId: string; atMessage: number | null } }) | null;
  let claim = await readForkClaim(env, entry.tenantId, targetId);
  if (saved?.deleted) {
    if (claim) await releaseForkClaim(env, entry.tenantId, claim);
    throw new ApiError(410, "Fork was deleted", "AGENT_GONE");
  }
  const answer = async (ready: NonNullable<typeof saved>) => {
    if (ready.forkedFrom?.agentId !== entry.id) throw new ApiError(409, "Key belongs to another agent");
    if (claim) await releaseForkClaim(env, entry.tenantId, claim);
    return json({ id: ready.id, ...(includeToken ? { token: await agentToken(env.API_TOKEN, ready.id, ready.tokenVersion) } : {}), expiresAt: ready.expiresAt, forkedFrom: ready.forkedFrom }, 201);
  };
  if (saved?.forkedFrom) return answer(saved);
  if (saved && !claim) throw new ApiError(409, "Key belongs to another agent");
  if (claim && claim.sourceId !== entry.id) throw new ApiError(409, "Key belongs to another agent");
  if (claim?.expired || (claim && claim.expiresAt <= Date.now())) {
    await releaseForkClaim(env, entry.tenantId, claim, true);
    throw new ApiError(410, "Incomplete fork expired after 24 hours; use a new key", "FORK_EXPIRED");
  }
  if (!claim) {
    const snapshot = await payload(await call(env, entry.id, "/fork-snapshot", { atMessage: input.atMessage }));
    const at = snapshot.through as number | null;
    const initialMessages = snapshot.messages;
    const { key: _key, atMessage: _at, ...settings } = input;
    if (input.name !== undefined && typeof input.name !== "string") throw new ApiError(400, "name must be text");
    const workspace = await forkWorkspaceMounts(entry.config.mounts, entry.id, targetId, entry.tenantId);
    const config = { ...withoutOnExpire(entry.config), ...settings, name: input.name as string | undefined ?? (entry.config.name ? `${entry.config.name} (fork)`.slice(0, 120) : undefined), mounts: workspace.mounts, initialMessages, idleTtlSeconds: null, ttlSeconds: input.ttlSeconds === undefined ? (suppliedKey ? null : 86400) : input.ttlSeconds };
    configuration({...config,mounts:config.mounts.filter(m=>!("volumeId"in m))}, env.MODEL);
    const fingerprint = await digest(canonical(JSON.parse(JSON.stringify({ sourceId: entry.id, atMessage: at, config }))));
    const ttl = env.TEST_MODE === "1" && request.headers.get("x-camel-test-fork-short-ttl") === "1" ? 1000 : 86400_000;
    claim = await claimFork(env, entry.tenantId, { sourceId: entry.id, targetId, key, fingerprint, atMessage: at, copyPrivate: workspace.copyPrivate, config, model: snapshot.model, origin: new URL(request.url).origin, expiresAt: Date.now() + ttl });
  }
  try {
    // The plan predates Directory creation. Its immutable source version is
    // retained in the claim, so retries use the same history and files.
    saved = await directory.get(key) as typeof saved;
    if (saved?.forkedFrom) return answer(saved);
    const captured = claim.copyPrivate ? await claimAgentWorkspace(env, entry.tenantId, claim.sourceId, targetId, claim.expiresAt) : undefined;
    const fail = env.TEST_MODE === "1" ? request.headers.get("x-camel-test-fork-failure") : null;
    if (fail === "claimed") throw new ApiError(503, "Injected fork interruption before creation");
    if (claim.copyPrivate) await copyAgentWorkspace(env, entry.tenantId, claim.sourceId, targetId, captured, fail === "copied" ? 1 : undefined);
    // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
    const legacy=(claim.config.mounts??[]).filter(m=>m.volumeId);
    const internalMounts=legacy.length?[...await (await import('./repos/mounts.ts')).prepareMounts(env as import('./repos/registry.ts').RepoEnv,entry.tenantId,targetId,(claim.config.mounts??[]).filter(m=>!m.volumeId)),...legacy]:undefined;
    const created = result(await directory.upsert(claim.config, key, claim.origin, { sourceId: claim.sourceId, fingerprint: claim.fingerprint },false,internalMounts));
    const workspaces = new Workspaces(database(env));
    const inherited = await workspaces.current(entry.tenantId, "agent", entry.id);
    await workspaces.assign(entry.tenantId, "agent", created.id, inherited?.workspace ?? null, true, true);
    if (fail === "copied") throw new ApiError(503, "Injected fork interruption after repo creation");
    if (fail === "created") throw new ApiError(503, "Injected fork interruption after creation");
    if (claim.model) {
      // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
      const legacyPinnedVolumes=await (await import('./legacy-prompt-attachments.ts')).inheritLegacyHistoryPins(env,entry.tenantId,claim.sourceId,created.id,claim.config.initialMessages??[]);
      await payload(await call(env, created.id, "/context/import", { model: claim.model, ...(legacyPinnedVolumes.length?{legacyPinnedVolumes}:{}) }));
    }
    const forkedFrom = { agentId: claim.sourceId, atMessage: claim.atMessage };
    const updated = await withSql(env, sql => sql.query("update agents set header=(jsonb_set(header::jsonb,'{forkedFrom}',$3::jsonb)-'pendingFork')::json where tenant=$1 and id=$2 and not revoked returning header", [entry.tenantId, created.id, JSON.stringify(forkedFrom)]));
    if (!updated.rows.length) throw new ApiError(410, "Fork was deleted", "AGENT_GONE");
    return answer(updated.rows[0].header);
  } catch (error) {
    // A concurrent retry may finish and release its read-set while this request
    // is suspended. Its completed header is the authoritative result.
    saved = await directory.get(key) as typeof saved;
    if (saved?.deleted) { await releaseForkClaim(env, entry.tenantId, claim); throw error; }
    if (saved?.forkedFrom) return answer(saved);
    if (error instanceof ApiError && error.code === "FORK_CONFLICT") await releaseForkClaim(env, entry.tenantId, claim);
    throw error;
  }
}
