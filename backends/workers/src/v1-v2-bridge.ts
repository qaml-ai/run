import { createHash } from "node:crypto";
import { HttpError } from "../../../src/core/http-error.ts";
import { readText } from "./account-http.ts";
import type { Env } from "./agent-types.ts";
import type { Db } from "./postgres.ts";

const VALID_V2_BUILTINS = new Set([
  "bash",
  "files",
  "codemode",
  "delegate",
  "workflows",
  "web_search",
  "web_fetch",
  "human",
  "computer",
  "schedule",
]);

const BUILTIN_ALIASES: Record<string, string> = {
  ask_user: "human",
  ask_human: "human",
  file_tools: "files",
  code_mode: "codemode",
};

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

const sha256Hex = (input: string) => createHash("sha256").update(input).digest("hex");

export const v1DefinitionId = (tenant: string, key: string) =>
  `def_${sha256Hex(`${tenant}:${key}`).slice(0, 20)}`;

export const v1ClientId = (tenant: string, key: string) =>
  `client_${sha256Hex(`${tenant}:${key}`).slice(0, 40)}`;

export interface BridgedDefinitionMeta {
  id: string;
  key?: string;
  name: string;
  revision: number;
  spec: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface BridgedAgentMeta {
  id: string;
  v2AgentId: string;
  key?: string;
  name: string;
  metadata: Record<string, unknown>;
  definition?: { id: string; revision: number };
  createdAt: number;
}

async function readJsonBody(request: Request, limit = 6 * 1024 * 1024): Promise<Record<string, unknown>> {
  const text = await readText(request.body, limit);
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Expected JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function mapV1BuiltinsToV2(spec: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const rawBuiltins = Array.isArray(spec.builtins) ? spec.builtins : [];
  for (const item of rawBuiltins) {
    if (typeof item !== "string") continue;
    const mapped = BUILTIN_ALIASES[item] ?? item;
    if (VALID_V2_BUILTINS.has(mapped)) out.add(mapped);
  }
  if (spec.fileTools === true) out.add("files");
  if (spec.codeMode === true) out.add("codemode");
  if (spec.delegate && typeof spec.delegate === "object") out.add("delegate");
  if (spec.computer && typeof spec.computer === "object") out.add("computer");
  return [...out];
}

export function v1SpecToV2Config(spec: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (typeof spec.model === "string" && spec.model.trim()) {
    config.model = spec.model.trim();
  }
  const promptParts: string[] = [];
  if (typeof spec.systemPrompt === "string" && spec.systemPrompt.trim()) {
    promptParts.push(spec.systemPrompt.trim());
  } else if (typeof spec.instructions === "string" && spec.instructions.trim()) {
    promptParts.push(spec.instructions.trim());
  }
  if (typeof spec.systemPromptAppend === "string" && spec.systemPromptAppend.trim()) {
    promptParts.push(spec.systemPromptAppend.trim());
  }
  const delegate = spec.delegate as { agents?: Array<{ name?: string; definition?: string; description?: string }> } | undefined;
  if (delegate?.agents?.length) {
    const listed = delegate.agents
      .map((a) => `- ${a.name || a.definition}: definition="${a.definition || a.name}"${a.description ? ` (${a.description})` : ""}`)
      .join("\n");
    promptParts.push(
      `Available subagent definitions for delegate/spawn_agent (pass \`definition\` matching the slug below):\n${listed}`,
    );
  }
  if (promptParts.length) {
    config.instructions = promptParts.join("\n\n");
  }

  const builtins = mapV1BuiltinsToV2(spec);
  if (builtins.length) config.builtins = builtins;

  if (Array.isArray(spec.mcpServers) && spec.mcpServers.length) {
    config.mcpServers = spec.mcpServers
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && typeof (s as Record<string, unknown>).url === "string")
      .map((s) => ({
        name: typeof s.name === "string" && s.name.trim() ? s.name.trim() : "mcp",
        url: String(s.url),
        ...(s.headers && typeof s.headers === "object" ? { headers: s.headers } : {}),
      }));
  }

  const rawTools = Array.isArray(spec.tools)
    ? spec.tools
    : Array.isArray((spec.mcp as { tools?: unknown[] } | undefined)?.tools)
      ? (spec.mcp as { tools: unknown[] }).tools
      : [];
  if (rawTools.length) {
    config.tools = rawTools
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof (t as Record<string, unknown>).name === "string")
      .map((t) => ({
        name: String(t.name),
        description: typeof t.description === "string" ? t.description : "",
        ...(t.parameters && typeof t.parameters === "object" ? { parameters: t.parameters } : {}),
        ...(typeof t.url === "string" ? { url: t.url } : {}),
        ...(t.headers && typeof t.headers === "object" ? { headers: t.headers } : {}),
      }));
  }

  if (spec.queue && typeof spec.queue === "object") {
    config.queue = spec.queue;
  }
  if (spec.dreaming && typeof spec.dreaming === "object") {
    config.dreaming = spec.dreaming;
  }
  const limits = spec.limits as { idleTtlSeconds?: number } | undefined;
  const idleTtl = typeof spec.idleTtlSeconds === "number" ? spec.idleTtlSeconds : limits?.idleTtlSeconds;
  if (typeof idleTtl === "number" && Number.isFinite(idleTtl) && idleTtl > 0) {
    config.idleTtlSeconds = idleTtl;
  }
  const runLimits = spec.runLimits as { maxCostUsd?: number } | undefined;
  const spendLimit = typeof spec.spendLimit === "number" ? spec.spendLimit : runLimits?.maxCostUsd;
  if (typeof spendLimit === "number" && Number.isFinite(spendLimit) && spendLimit >= 0) {
    config.spendLimitUsd = spendLimit;
  }
  return config;
}

function definitionViewFromMeta(meta: BridgedDefinitionMeta) {
  const { channel: _channel, ...spec } = meta.spec;
  return {
    id: meta.id,
    name: meta.name,
    revision: meta.revision,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...spec,
  };
}

async function readPostgresDefinition(sql: Db, tenant: string, ref: string): Promise<BridgedDefinitionMeta | null> {
  const id = /^def_[a-f0-9]{20}$/.test(ref) ? ref : v1DefinitionId(tenant, ref);
  try {
    const { rows } = await sql.query<{
      id: string;
      name: string;
      revision: number;
      spec: Record<string, unknown>;
      created_at: number;
      updated_at: number;
    }>("SELECT id, name, revision, spec, created_at, updated_at FROM definitions WHERE tenant = $1 AND id = $2 LIMIT 1", [tenant, id]);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      ...(ref !== row.id ? { key: ref } : {}),
      name: row.name,
      revision: Number(row.revision),
      spec: row.spec ?? {},
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  } catch (err) {
    if ((err as { code?: string })?.code === "42501") return null;
    throw err;
  }
}

async function resolveDefinitionForBridge(
  env: Env,
  sql: Db,
  tenant: string,
  ref: string,
): Promise<BridgedDefinitionMeta | null> {
  const bridge = env.V2_LEGACY_RUNS;
  if (!bridge?.getMeta) return readPostgresDefinition(sql, tenant, ref);
  const id = /^def_[a-f0-9]{20}$/.test(ref) ? ref : v1DefinitionId(tenant, ref);
  const meta = await bridge.getMeta<BridgedDefinitionMeta>(tenant, "def", id);
  if (meta) return meta;
  return readPostgresDefinition(sql, tenant, ref);
}

async function syncDefinitionToV2(
  env: Env,
  sql: Db,
  tenant: string,
  meta: BridgedDefinitionMeta,
  extraSlug?: string,
  visited = new Set<string>(),
): Promise<void> {
  const bridge = env.V2_LEGACY_RUNS;
  if (!bridge?.bridge) return;
  if (visited.has(meta.id)) return;
  visited.add(meta.id);

  // Recursively ensure any delegated subagent definitions exist in v2 TenantDO.
  const delegate = meta.spec.delegate as { agents?: Array<{ definition?: string }> } | undefined;
  if (delegate?.agents?.length) {
    for (const sub of delegate.agents) {
      if (!sub?.definition) continue;
      const subMeta = await resolveDefinitionForBridge(env, sql, tenant, sub.definition);
      if (subMeta) {
        await syncDefinitionToV2(env, sql, tenant, subMeta, sub.definition, visited);
      }
    }
  }

  const v2Config = v1SpecToV2Config(meta.spec);
  const slugs = new Set<string>([meta.id]);
  if (meta.key) slugs.add(meta.key);
  if (extraSlug) slugs.add(extraSlug);

  for (const slug of slugs) {
    const res = await bridge.bridge(
      tenant,
      `/v2/definitions/${encodeURIComponent(slug)}`,
      new Request(`https://legacy-v2.internal/v2/definitions/${encodeURIComponent(slug)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(v2Config),
      }),
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new HttpError(res.status >= 400 && res.status < 500 ? res.status : 502, detail || "Failed to sync definition to v2");
    }
  }
}

export async function handleBridgedDefinitionRoutes(
  request: Request,
  env: Env,
  sql: Db,
  tenant: string,
): Promise<Response | undefined> {
  const bridge = env.V2_LEGACY_RUNS;
  if (!bridge?.bridge || !bridge.putMeta || !bridge.getMeta || !bridge.listMeta || !bridge.deleteMeta) return;
  const url = new URL(request.url);
  const match = /^\/v1\/definitions(?:\/([^/]+)(\/agents)?)?$/.exec(url.pathname);
  if (!match) return;
  const ref = match[1] ? decodeURIComponent(match[1]) : undefined;
  const agentsTail = !!match[2];

  if (request.method === "GET") {
    if (ref) {
      const def = await resolveDefinitionForBridge(env, sql, tenant, ref);
      if (!def) throw new HttpError(404, `Unknown definition ${ref}`, "NOT_FOUND");
      if (agentsTail) {
        const metas = await bridge.listMeta<BridgedAgentMeta>(tenant, "agent");
        const matched = metas
          .filter(({ data }) => data.definition?.id === def.id)
          .map(({ data }) => ({ id: data.id, revision: data.definition?.revision ?? def.revision }));
        return json(matched);
      }
      return json(definitionViewFromMeta(def));
    }
    const merged = new Map<string, BridgedDefinitionMeta>();
    try {
      const { rows } = await sql.query<{
        id: string;
        name: string;
        revision: number;
        spec: Record<string, unknown>;
        created_at: number;
        updated_at: number;
      }>("SELECT id, name, revision, spec, created_at, updated_at FROM definitions WHERE tenant = $1 ORDER BY created_at, id", [tenant]);
      for (const row of rows) {
        merged.set(row.id, {
          id: row.id,
          name: row.name,
          revision: Number(row.revision),
          spec: row.spec ?? {},
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        });
      }
    } catch (err) {
      if ((err as { code?: string })?.code !== "42501") throw err;
    }
    const deleted = new Set((await bridge.listMeta<boolean>(tenant, "def_deleted")).map((r) => r.id));
    for (const id of deleted) merged.delete(id);
    for (const { data } of await bridge.listMeta<BridgedDefinitionMeta>(tenant, "def")) {
      merged.set(data.id, data);
    }
    return json([...merged.values()].map(definitionViewFromMeta));
  }

  if (request.method === "DELETE" && ref && !agentsTail) {
    const def = await resolveDefinitionForBridge(env, sql, tenant, ref);
    if (!def) throw new HttpError(404, `Unknown definition ${ref}`, "NOT_FOUND");
    await bridge.bridge(
      tenant,
      `/v2/definitions/${encodeURIComponent(def.id)}`,
      new Request(`https://legacy-v2.internal/v2/definitions/${encodeURIComponent(def.id)}`, { method: "DELETE" }),
    );
    if (def.key) {
      await bridge.bridge(
        tenant,
        `/v2/definitions/${encodeURIComponent(def.key)}`,
        new Request(`https://legacy-v2.internal/v2/definitions/${encodeURIComponent(def.key)}`, { method: "DELETE" }),
      );
    }
    await bridge.deleteMeta(tenant, "def", def.id);
    await bridge.putMeta(tenant, "def_deleted", def.id, true);
    return json({ deleted: true });
  }

  if ((request.method === "POST" && !ref) || (request.method === "PATCH" && ref && !agentsTail)) {
    const body = await readJsonBody(request, 1024 * 1024);
    const keyHeader = request.headers.get("Idempotency-Key")?.trim() || undefined;
    if (keyHeader && !/^[A-Za-z0-9_.-]{1,120}$/.test(keyHeader)) {
      throw new HttpError(400, "Invalid Idempotency-Key");
    }
    const existing = ref
      ? await resolveDefinitionForBridge(env, sql, tenant, ref)
      : keyHeader
        ? await resolveDefinitionForBridge(env, sql, tenant, keyHeader)
        : null;
    if (request.method === "PATCH" && !existing) {
      throw new HttpError(404, `Unknown definition ${ref}`, "NOT_FOUND");
    }
    if (body.revision !== undefined && (request.method === "POST" || body.revision !== existing?.revision)) {
      throw new HttpError(409, "Definition revision changed", "CONFLICT");
    }

    const id = existing?.id ?? (keyHeader ? v1DefinitionId(tenant, keyHeader) : `def_${sha256Hex(crypto.randomUUID()).slice(0, 20)}`);
    const rawName = body.name === undefined && request.method === "PATCH" ? existing?.name : body.name;
    if (typeof rawName !== "string" || !rawName.trim() || rawName.trim().length > 120) {
      throw new HttpError(400, "name must contain 1–120 characters");
    }
    const name = rawName.trim();
    const { name: _n, revision: _r, apply: _a, ...changes } = body;
    const mergedSpec: Record<string, unknown> = request.method === "PATCH" ? { ...(existing?.spec ?? {}), ...changes } : changes;
    for (const [k, v] of Object.entries(mergedSpec)) {
      if (v === null) delete mergedSpec[k];
    }

    const now = Date.now();
    const next: BridgedDefinitionMeta = {
      id,
      key: keyHeader ?? existing?.key,
      name,
      revision: (existing?.revision ?? 0) + 1,
      spec: mergedSpec,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await syncDefinitionToV2(env, sql, tenant, next, keyHeader);
    await bridge.putMeta(tenant, "def", id, next);
    await bridge.deleteMeta(tenant, "def_deleted", id);
    return json(definitionViewFromMeta(next), request.method === "POST" ? 201 : 200);
  }
}

export async function handleBridgedAgentCreate(
  request: Request,
  env: Env,
  sql: Db,
  tenant: string,
): Promise<Response | undefined> {
  const bridge = env.V2_LEGACY_RUNS;
  if (!bridge?.bridge || !bridge.putMeta) return;
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/v1/agents") return;

  const body = await readJsonBody(request, 6 * 1024 * 1024);
  const suppliedKey =
    typeof body.key === "string" && body.key.trim()
      ? body.key.trim()
      : request.headers.get("Idempotency-Key")?.trim() || undefined;
  const effectiveKey = suppliedKey ?? crypto.randomUUID();
  const clientId = v1ClientId(tenant, effectiveKey);

  let defMeta: BridgedDefinitionMeta | null = null;
  if (typeof body.definition === "string" && body.definition.trim()) {
    defMeta = await resolveDefinitionForBridge(env, sql, tenant, body.definition.trim());
    if (!defMeta) {
      throw new HttpError(404, `Unknown definition ${body.definition}`, "NOT_FOUND");
    }
    await syncDefinitionToV2(env, sql, tenant, defMeta, body.definition.trim());
  }

  const mergedSpec: Record<string, unknown> = {
    ...(defMeta?.spec ?? {}),
    ...body,
    ...(defMeta?.spec.systemPrompt && typeof body.systemPromptAppend === "string"
      ? { systemPrompt: defMeta.spec.systemPrompt, systemPromptAppend: body.systemPromptAppend }
      : {}),
  };
  const v2Input = v1SpecToV2Config(mergedSpec);
  if (defMeta) {
    v2Input.definition = defMeta.id;
  }

  const res = await bridge.bridge(
    tenant,
    `/v2/agents/${encodeURIComponent(clientId)}`,
    new Request(`https://legacy-v2.internal/v2/agents/${encodeURIComponent(clientId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(v2Input),
    }),
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new HttpError(res.status, String((data.error as { message?: string } | string | undefined) ?? "Failed to create agent"));
  }

  const v2AgentId = String(data.id ?? "");
  const initialMessages = body.initialMessages ?? body.importMessages;
  if (Array.isArray(initialMessages) && initialMessages.length > 0 && v2AgentId) {
    await bridge.bridge(
      tenant,
      `/v2/agents/${encodeURIComponent(v2AgentId)}/history/import`,
      new Request(`https://legacy-v2.internal/v2/agents/${encodeURIComponent(v2AgentId)}/history/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: initialMessages, repair: true }),
      }),
    );
  }

  const metadata =
    body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : {};
  const name = typeof body.name === "string" ? body.name : (defMeta?.name ?? "");
  const meta: BridgedAgentMeta = {
    id: clientId,
    v2AgentId,
    ...(suppliedKey ? { key: suppliedKey } : {}),
    name,
    metadata,
    ...(defMeta ? { definition: { id: defMeta.id, revision: defMeta.revision } } : {}),
    createdAt: Date.now(),
  };
  await bridge.putMeta(tenant, "agent", clientId, meta);

  const configHash = sha256Hex(JSON.stringify(v2Input)).slice(0, 16);
  return json(
    {
      id: clientId,
      ...(suppliedKey ? { key: suppliedKey } : {}),
      token: data.agentToken,
      name,
      type: "agent",
      model: data.model,
      metadata,
      ...(defMeta ? { definition: { id: defMeta.id, revision: defMeta.revision } } : {}),
      connected: false,
      running: false,
      expiresAt: null,
      configHash,
      resume: null,
    },
    data.created ? 201 : 200,
  );
}

export async function handleBridgedAgentMutation(
  request: Request,
  env: Env,
  sql: Db,
  tenant: string,
  agentId: string,
  tail: string,
): Promise<Response | undefined> {
  const bridge = env.V2_LEGACY_RUNS;
  if (!bridge?.bridge || !bridge.resolveBridgedAgent) return;

  // Check both migrated routes and bridged agents.
  let v2TenantId: string | undefined;
  let v2AgentId: string | undefined;
  let isBridged = false;
  const bridged = await bridge.resolveBridgedAgent(tenant, agentId);
  if (bridged) {
    v2TenantId = bridged.tenantId;
    v2AgentId = bridged.agentId;
    isBridged = true;
  } else {
    const { rows } = await sql.query<{ destination_tenant: string; destination_agent: string }>(
      "SELECT destination_tenant, destination_agent FROM agent_v2_routes WHERE tenant = $1 AND agent = $2 LIMIT 1",
      [tenant, agentId],
    );
    if (rows[0]) {
      v2TenantId = rows[0].destination_tenant;
      v2AgentId = rows[0].destination_agent;
    }
  }
  if (!v2TenantId || !v2AgentId) return;

  if (request.method === "DELETE" && tail === "") {
    const res = isBridged
      ? await bridge.bridge(
          tenant,
          `/v2/agents/${encodeURIComponent(v2AgentId)}`,
          new Request(`https://legacy-v2.internal/v2/agents/${encodeURIComponent(v2AgentId)}`, { method: "DELETE" }),
        )
      : await bridge.route(
          v2TenantId,
          v2AgentId,
          new Request(`https://legacy-v2.internal/v2/agents/${encodeURIComponent(v2AgentId)}`, { method: "DELETE" }),
        );
    if (isBridged && bridge.deleteMeta) {
      await bridge.deleteMeta(tenant, "agent", agentId);
    }
    if (!res.ok && res.status !== 404) {
      return res;
    }
    return json({ deleted: true });
  }

  if (request.method === "POST" && tail === "/abort") {
    const res = isBridged
      ? await bridge.bridge(
          tenant,
          `/v2/agents/${encodeURIComponent(v2AgentId)}/abort`,
          new Request(`https://legacy-v2.internal/v2/agents/${encodeURIComponent(v2AgentId)}/abort`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        )
      : await bridge.route(
          v2TenantId,
          v2AgentId,
          new Request(`https://legacy-v2.internal/v2/agents/${encodeURIComponent(v2AgentId)}/abort`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        );
    if (!res.ok) return res;
    return json({ aborted: true });
  }

  if (request.method === "PATCH" && (tail === "" || tail === "/configuration")) {
    const patch = await readJsonBody(request, 1024 * 1024);
    if (isBridged) {
      const v2Patch = v1SpecToV2Config(patch);
      const res = await bridge.bridge(
        tenant,
        `/v2/agents/${encodeURIComponent(agentId)}`,
        new Request(`https://legacy-v2.internal/v2/agents/${encodeURIComponent(agentId)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(v2Patch),
        }),
      );
      if (!res.ok) return res;
      const updated = (await res.json()) as Record<string, unknown>;
      return json({ id: agentId, model: updated.model, updated: true });
    }
    if (typeof patch.model === "string" && patch.model.trim()) {
      const detailRes = await bridge.route(
        v2TenantId,
        v2AgentId,
        new Request(`https://legacy-v2.internal/v2/agents/${encodeURIComponent(v2AgentId)}/detail`),
      );
      if (!detailRes.ok) return detailRes;
      const current = (await detailRes.json()) as { model?: string };
      const res = await bridge.route(
        v2TenantId,
        v2AgentId,
        new Request(`https://legacy-v2.internal/v2/agents/${encodeURIComponent(v2AgentId)}/model`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: patch.model.trim(), expectedModel: current.model }),
        }),
      );
      if (!res.ok) return res;
      return json({ id: agentId, model: patch.model.trim(), updated: true });
    }
  }
}

export async function handleBridgedStatelessRuns(
  request: Request,
  env: Env,
  sql: Db,
  tenant: string,
): Promise<Response | undefined> {
  const bridge = env.V2_LEGACY_RUNS;
  if (!bridge?.bridge || !bridge.putMeta || !bridge.getMeta) return;
  const url = new URL(request.url);
  const match = /^\/v1\/runs(?:\/(run_[a-f0-9]{16,40}))?$/.exec(url.pathname);
  if (!match) return;
  const runIdParam = match[1];

  if (!runIdParam && request.method === "POST") {
    const body = await readJsonBody(request, 7 * 1024 * 1024);
    const inputText =
      typeof body.input === "string"
        ? body.input
        : typeof body.prompt === "string"
          ? body.prompt
          : "";
    if (!inputText.trim()) {
      throw new HttpError(400, "`input` is required");
    }

    const startedAt = Date.now();
    const runId = `run_${sha256Hex(request.headers.get("Idempotency-Key") ?? crypto.randomUUID()).slice(0, 40)}`;
    const hasAgentFeatures = Boolean(
      body.definition ||
      (Array.isArray(body.builtins) && body.builtins.length) ||
      body.delegate ||
      (Array.isArray(body.mcpServers) && body.mcpServers.length) ||
      body.fileTools ||
      body.codeMode,
    );

    if (hasAgentFeatures) {
      let defMeta: BridgedDefinitionMeta | null = null;
      if (typeof body.definition === "string" && body.definition.trim()) {
        defMeta = await resolveDefinitionForBridge(env, sql, tenant, body.definition.trim());
        if (!defMeta) throw new HttpError(404, `Unknown definition ${body.definition}`, "NOT_FOUND");
        await syncDefinitionToV2(env, sql, tenant, defMeta, body.definition.trim());
      }
      const v2Cfg = v1SpecToV2Config({ ...(defMeta?.spec ?? {}), ...body });
      const waitParam = url.searchParams.get("wait");
      const shouldWait = waitParam !== null ? Number(waitParam) > 0 : body.wait !== false;
      const res = await bridge.bridge(
        tenant,
        `/v2/agents/${encodeURIComponent(runId)}`,
        new Request(`https://legacy-v2.internal/v2/agents/${encodeURIComponent(runId)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...v2Cfg,
            ...(defMeta ? { definition: defMeta.id } : {}),
            prompt: inputText,
            wait: shouldWait,
            ...(body.output ? { outputSchema: body.output } : {}),
          }),
        }),
      );
      const created = (await res.json().catch(() => ({}))) as {
        model?: string;
        run?: {
          status?: string;
          text?: string;
          output?: unknown;
          error?: { code: string; message: string } | null;
          usage?: { inputTokens: number; outputTokens: number; costUsd: number };
          toolCalls?: Array<{ id: string; name: string; ok: boolean }>;
          startedAt?: number;
          endedAt?: number;
        };
      };
      if (!res.ok) return json(created, res.status);
      const run = created.run ?? {};
      const endedAt = run.endedAt ?? (run.status === "completed" || run.status === "failed" ? Date.now() : null);
      const view = {
        id: runId,
        status: run.status ?? "completed",
        text: run.text ?? "",
        ...(run.output !== undefined && run.output !== null ? { output: run.output } : {}),
        error: run.error ?? null,
        usage: run.usage
          ? {
              responses: 1,
              input: run.usage.inputTokens,
              output: run.usage.outputTokens,
              cacheRead: 0,
              cacheWrite: 0,
              costUsd: run.usage.costUsd,
            }
          : null,
        servedModel: created.model,
        toolCalls: (run.toolCalls ?? []).map((t) => ({ toolCallId: t.id, tool: t.name, ok: t.ok })),
        toolErrors: [],
        sourceErrors: [],
        files: [],
        createdAt: startedAt,
        startedAt: run.startedAt ?? startedAt,
        endedAt,
        expiresAt: endedAt ? endedAt + 86_400_000 : null,
      };
      await bridge.putMeta(tenant, "run", runId, view);
      return json(view, view.status === "running" || view.status === "queued" ? 202 : 200);
    }

    const res = await bridge.bridge(
      tenant,
      "/v2/runs",
      new Request("https://legacy-v2.internal/v2/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: inputText,
          ...(typeof body.model === "string" ? { model: body.model } : {}),
          ...(typeof body.systemPrompt === "string"
            ? { instructions: body.systemPrompt }
            : typeof body.instructions === "string"
              ? { instructions: body.instructions }
              : {}),
          ...(body.output ? { outputSchema: body.output } : {}),
          ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
          ...(typeof body.maxSteps === "number" ? { maxSteps: body.maxSteps } : {}),
        }),
      }),
    );
    const out = (await res.json().catch(() => ({}))) as {
      id?: string;
      status?: string;
      text?: string;
      output?: unknown;
      error?: { code: string; message: string } | null;
      usage?: { inputTokens: number; outputTokens: number; costUsd: number };
      model?: string;
      toolCalls?: Array<{ id: string; name: string; ok: boolean }>;
    };
    if (!res.ok) return json(out, res.status);
    const endedAt = Date.now();
    const view = {
      id: runId,
      status: out.status ?? "completed",
      text: out.text ?? "",
      ...(out.output !== undefined && out.output !== null ? { output: out.output } : {}),
      error: out.error ?? null,
      usage: out.usage
        ? {
            responses: 1,
            input: out.usage.inputTokens,
            output: out.usage.outputTokens,
            cacheRead: 0,
            cacheWrite: 0,
            costUsd: out.usage.costUsd,
          }
        : null,
      servedModel: out.model,
      toolCalls: (out.toolCalls ?? []).map((t) => ({ toolCallId: t.id, tool: t.name, ok: t.ok })),
      toolErrors: [],
      sourceErrors: [],
      files: [],
      createdAt: startedAt,
      startedAt,
      endedAt,
      expiresAt: endedAt + 86_400_000,
    };
    await bridge.putMeta(tenant, "run", runId, view);
    return json(view, 200);
  }

  if (runIdParam && request.method === "GET") {
    const saved = await bridge.getMeta<Record<string, unknown>>(tenant, "run", runIdParam);
    if (!saved) throw new HttpError(404, "Unknown run", "NOT_FOUND");
    return json(saved);
  }
}

export async function handleBridgedMediaOrDecision(
  request: Request,
  env: Env,
  tenant: string,
): Promise<Response | undefined> {
  const bridge = env.V2_LEGACY_RUNS;
  if (!bridge?.bridge || request.method !== "POST") return;
  const pathname = new URL(request.url).pathname;
  const mapped: Record<string, string> = {
    "/v1/speech": "/v2/speech",
    "/v1/transcriptions": "/v2/transcriptions",
    "/v1/images": "/v2/images",
    "/v1/decisions": "/v2/decisions",
  };
  const v2Path = mapped[pathname];
  if (!v2Path) return;
  return bridge.bridge(tenant, v2Path, request);
}
