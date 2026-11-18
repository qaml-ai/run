import { AgentHandle, type AgentTransport } from "./agent.ts";
import { isLocalTool, toWireToolDefinition } from "./tools.ts";
import {
  CamelRunError, type AddCreditsInput, type AgentConfig, type AgentDefinition, type AgentSummary,
  type ApiToken, type BillingInfo, type CamelRunAdminOptions, type CamelRunOptions, type ChannelConfig,
  type ChannelInfo, type CreatedTenant, type CreateTenantOptions, type CreateTokenInput,
  type DecisionRequest, type DecisionResult, type DefinitionConfig, type FetchLike,
  type GenerateImageInput, type ImageRecord, type LocalTool, type ProviderConfig, type RepoCommit,
  type RepoDiffChange, type RepoEntry, type RepoGrepMatch, type RepoInfo, type RepoReadResult,
  type RepoWriteInput, type RepoWriteResult, type ResponseLike, type RunRecord, type SpeechInput,
  type SpeechResult, type StatelessRunOptions, type TenantInfo, type TranscribeInput,
  type TranscriptionResult, type VoiceSession, type WebhookEndpoint, type WebSocketConstructorLike,
} from "./types.ts";

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : "";
}

function unwrapList<T>(res: unknown, key: string): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object") {
    const obj = res as Record<string, unknown>;
    if (Array.isArray(obj[key])) return obj[key] as T[];
    if (Array.isArray(obj.items)) return obj.items as T[];
  }
  return [];
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function throwHttpError(res: ResponseLike, fallbackPath: string): Promise<never> {
  const raw = await res.text().catch(() => "");
  let code = `http_${res.status}`;
  let message = raw || `Request to ${fallbackPath} failed with status ${res.status}`;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string } | string; message?: string };
      if (parsed.error && typeof parsed.error === "object") {
        if (parsed.error.code) code = parsed.error.code;
        if (parsed.error.message) message = parsed.error.message;
      } else if (typeof parsed.error === "string") message = parsed.error;
      else if (typeof parsed.message === "string") message = parsed.message;
    } catch {}
  }
  throw new CamelRunError(message, { code, status: res.status });
}

export class CamelRunAdmin {
  readonly baseUrl: string;
  private readonly adminKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: CamelRunAdminOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.adminKey = options.adminKey;
    this.fetchImpl = options.fetch ?? (globalThis.fetch.bind(globalThis) as unknown as FetchLike);
  }

  async createTenant(input: { name: string; initialCreditsUsd?: number }): Promise<CreatedTenant> {
    const res = await this.fetchImpl(`${this.baseUrl}/v2/tenants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Key": this.adminKey },
      body: JSON.stringify(input),
    });
    if (!res.ok) await throwHttpError(res, "/v2/tenants");
    return (await res.json()) as CreatedTenant;
  }
}

export class CamelRun {
  static createTenant(options: CreateTenantOptions): Promise<CreatedTenant> {
    return new CamelRunAdmin(options).createTenant({ name: options.name, initialCreditsUsd: options.initialCreditsUsd });
  }

  readonly baseUrl: string;
  readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly customFetch: boolean;
  private readonly wsImpl?: WebSocketConstructorLike;
  private readonly activeHandles = new Set<AgentHandle>();
  private readonly transport: AgentTransport;

  readonly tokens = {
    create: (input?: CreateTokenInput): Promise<ApiToken> => this.requestJson("POST", "/v2/tokens", input ?? {}),
    list: async (): Promise<ApiToken[]> => unwrapList<ApiToken>(await this.requestJson("GET", "/v2/tokens"), "tokens"),
    delete: (id: string): Promise<{ deleted: boolean }> => this.requestJson("DELETE", `/v2/tokens/${encodeURIComponent(id)}`),
  };

  readonly providers = {
    set: (provider: string, config: ProviderConfig): Promise<{ provider: string; ok?: boolean; configured?: boolean }> =>
      this.requestJson("PUT", `/v2/providers/${encodeURIComponent(provider)}`, config),
  };

  readonly billing = {
    get: (): Promise<BillingInfo> => this.requestJson("GET", "/v2/billing"),
    addCredits: ({ adminKey, refId, ...rest }: AddCreditsInput): Promise<{ balanceUsd: number }> =>
      this.requestJson("POST", "/v2/billing/credits", { ...rest, refId: refId ?? crypto.randomUUID() }, { headers: { "X-Admin-Key": adminKey } }),
  };

  readonly definitions = {
    upsert: (slug: string, config: DefinitionConfig): Promise<AgentDefinition> =>
      this.requestJson("PUT", `/v2/definitions/${encodeURIComponent(slug)}`, config),
    list: async (): Promise<AgentDefinition[]> => unwrapList<AgentDefinition>(await this.requestJson("GET", "/v2/definitions"), "definitions"),
    delete: (slug: string): Promise<{ deleted: boolean }> => this.requestJson("DELETE", `/v2/definitions/${encodeURIComponent(slug)}`),
  };

  readonly repos = {
    create: (options?: { name?: string }): Promise<RepoInfo> => this.requestJson("POST", "/v2/repos", options ?? {}),
    list: async (): Promise<RepoInfo[]> => unwrapList<RepoInfo>(await this.requestJson("GET", "/v2/repos"), "repos"),
    get: (repoId: string): Promise<RepoInfo> => this.requestJson("GET", `/v2/repos/${encodeURIComponent(repoId)}`),
    delete: (repoId: string): Promise<{ deleted: boolean }> => this.requestJson("DELETE", `/v2/repos/${encodeURIComponent(repoId)}`),
    read: (repoId: string, options: { path: string; at?: string; offset?: number; limit?: number }): Promise<RepoReadResult> =>
      this.requestJson("GET", `/v2/repos/${encodeURIComponent(repoId)}/files${buildQuery(options)}`),
    write: (repoId: string, input: RepoWriteInput): Promise<RepoWriteResult> => {
      const { path, content, base64, mode, puts, ...rest } = input;
      const resolvedPuts = puts ?? (path ? [{ path, content, base64, mode }] : undefined);
      return this.requestJson("POST", `/v2/repos/${encodeURIComponent(repoId)}/write`, { ...rest, ...(resolvedPuts ? { puts: resolvedPuts } : {}) });
    },
    restore: (repoId: string, input: { targetCommit: string; ref?: string; message?: string }): Promise<{ commit: string; tree: string }> =>
      this.requestJson("POST", `/v2/repos/${encodeURIComponent(repoId)}/restore`, input),
    ls: async (repoId: string, options?: { at?: string; path?: string; recursive?: boolean; glob?: string }): Promise<{ commit: string; entries: RepoEntry[] }> => {
      const q = buildQuery({ at: options?.at, path: options?.path, recursive: options?.recursive !== undefined ? (options.recursive ? 1 : 0) : undefined, glob: options?.glob });
      const res = await this.requestJson<unknown>("GET", `/v2/repos/${encodeURIComponent(repoId)}/ls${q}`);
      return Array.isArray(res) ? { commit: "", entries: res as RepoEntry[] } : (res as { commit: string; entries: RepoEntry[] });
    },
    grep: (repoId: string, input: { pattern: string; at?: string; pathPrefix?: string; maxMatches?: number }): Promise<{ commit: string; matches: RepoGrepMatch[] }> =>
      this.requestJson("POST", `/v2/repos/${encodeURIComponent(repoId)}/grep`, input),
    diff: (repoId: string, options: { from: string; to: string }): Promise<{ fromCommit: string; toCommit: string; changes: RepoDiffChange[] }> =>
      this.requestJson("GET", `/v2/repos/${encodeURIComponent(repoId)}/diff${buildQuery(options)}`),
    history: async (repoId: string, options?: { ref?: string; limit?: number }): Promise<{ commits: RepoCommit[] }> => {
      const res = await this.requestJson<unknown>("GET", `/v2/repos/${encodeURIComponent(repoId)}/history${buildQuery(options ?? {})}`);
      return Array.isArray(res) ? { commits: res as RepoCommit[] } : (res as { commits: RepoCommit[] });
    },
  };

  readonly agents = {
    upsert: async (key: string, config: AgentConfig): Promise<AgentHandle> => {
      const localTools = (config.tools ?? []).filter(isLocalTool);
      const wireTools = config.tools?.map(toWireToolDefinition);
      const summary = await this.requestJson<AgentSummary>("PUT", `/v2/agents/${encodeURIComponent(key)}`, { ...config, ...(wireTools ? { tools: wireTools } : {}) });
      const handle = this.registerHandle(summary, localTools);
      if (localTools.length > 0) {
        try { await handle.ensureToolSession(); }
        catch (err) { if (!this.customFetch || this.wsImpl) throw err; }
      }
      return handle;
    },
    get: async (idOrKey: string, options?: { tools?: LocalTool<any, any>[] }): Promise<AgentHandle> => {
      const summary = await this.requestJson<AgentSummary>("GET", `/v2/agents/${encodeURIComponent(idOrKey)}`);
      const handle = this.registerHandle(summary, options?.tools);
      if (options?.tools && options.tools.length > 0) await handle.ensureToolSession();
      return handle;
    },
    list: async (): Promise<AgentSummary[]> => unwrapList<AgentSummary>(await this.requestJson("GET", "/v2/agents"), "agents"),
    delete: (idOrKey: string): Promise<{ deleted: boolean }> => {
      for (const h of this.activeHandles) {
        if (h.id === idOrKey || h.key === idOrKey) { h.close(); this.activeHandles.delete(h); }
      }
      return this.requestJson("DELETE", `/v2/agents/${encodeURIComponent(idOrKey)}`);
    },
  };

  readonly runs = {
    create: <TOutput = unknown>(options: StatelessRunOptions): Promise<RunRecord<TOutput>> => this.requestJson("POST", "/v2/runs", options),
  };

  readonly decisions = {
    decide: <TChoice extends string = string>(request: DecisionRequest<TChoice>): Promise<DecisionResult<TChoice>> =>
      this.requestJson("POST", "/v2/decisions", request),
  };

  readonly voice = {
    createSession: (input: { agentIdOrKey: string; provider: "openai" | "elevenlabs"; voice?: string }): Promise<VoiceSession> =>
      this.requestJson("POST", "/v2/voice/sessions", input),
    invokeTool: (sessionId: string, input: { name: string; args?: Record<string, unknown>; callId?: string }): Promise<{ callId?: string; result: unknown; error?: string | null }> =>
      this.requestJson("POST", `/v2/voice/sessions/${encodeURIComponent(sessionId)}/tool`, input),
  };

  readonly channels = {
    create: (cfg: ChannelConfig): Promise<ChannelInfo> =>
      this.requestJson("POST", "/v2/channels", { ...cfg, kind: cfg.kind ?? cfg.type, type: cfg.type ?? cfg.kind }),
    sendInbound: (channelId: string, payload: Record<string, unknown>, headers?: Record<string, string>): Promise<Record<string, unknown>> =>
      this.requestJson("POST", `/v2/channels/${encodeURIComponent(channelId)}/inbound`, payload, headers ? { headers } : undefined),
  };

  readonly webhooks = {
    create: (input: { url: string; events?: string[]; secret?: string }): Promise<WebhookEndpoint> => this.requestJson("POST", "/v2/webhooks", input),
    list: async (): Promise<WebhookEndpoint[]> => unwrapList<WebhookEndpoint>(await this.requestJson("GET", "/v2/webhooks"), "webhooks"),
    delete: (id: string): Promise<{ deleted: boolean }> => this.requestJson("DELETE", `/v2/webhooks/${encodeURIComponent(id)}`),
  };

  readonly media = {
    transcribe: async ({ file, ...rest }: TranscribeInput): Promise<TranscriptionResult> => {
      let audioBase64 = rest.audioBase64;
      if (!audioBase64 && file) {
        const bytes = file instanceof Uint8Array ? file : file instanceof ArrayBuffer ? new Uint8Array(file) : new Uint8Array(await file.arrayBuffer());
        audioBase64 = bytesToBase64(bytes);
      }
      return this.requestJson("POST", "/v2/transcriptions", { ...rest, ...(audioBase64 ? { audioBase64 } : {}) });
    },
    speech: async (input: SpeechInput): Promise<SpeechResult> => {
      const res = await this.requestRaw("POST", "/v2/speech", { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const ct = res.headers.get("content-type") ?? "application/octet-stream";
      if (ct.includes("application/json")) {
        const json = (await res.json()) as Record<string, unknown>;
        const b64 = typeof json.audioBase64 === "string" ? json.audioBase64 : undefined;
        return { ...(json as unknown as SpeechResult), contentType: typeof json.contentType === "string" ? json.contentType : ct, ...(b64 ? { audio: base64ToBytes(b64) } : {}) };
      }
      return { audio: new Uint8Array(await res.arrayBuffer()), contentType: ct };
    },
    generateImage: (input: GenerateImageInput): Promise<ImageRecord> => this.requestJson("POST", "/v2/images", input),
    getImage: async (id: string): Promise<ImageRecord> => {
      const res = await this.requestRaw("GET", `/v2/images/${encodeURIComponent(id)}`);
      const ct = res.headers.get("content-type") ?? "application/octet-stream";
      return ct.includes("application/json") ? ((await res.json()) as ImageRecord) : { id, contentType: ct, data: new Uint8Array(await res.arrayBuffer()) };
    },
  };

  constructor(options: CamelRunOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.customFetch = Boolean(options.fetch);
    this.fetchImpl = options.fetch ?? (globalThis.fetch.bind(globalThis) as unknown as FetchLike);
    this.wsImpl = options.WebSocket;
    this.transport = {
      baseUrl: this.baseUrl, apiKey: this.apiKey, WebSocket: this.wsImpl,
      requestJson: (m, p, b, init) => this.requestJson(m, p, b, init),
      requestRaw: (m, p, init) => this.requestRaw(m, p, init),
      createHandle: (summary, localTools) => this.registerHandle(summary, localTools),
      untrackHandle: (h) => { this.activeHandles.delete(h); },
    };
  }

  me(): Promise<TenantInfo> { return this.requestJson("GET", "/v2/me"); }

  close(): void {
    for (const h of this.activeHandles) h.close();
    this.activeHandles.clear();
  }

  private registerHandle(summary: AgentSummary, localTools?: LocalTool<any, any>[]): AgentHandle {
    for (const existing of this.activeHandles) {
      if (existing.id === summary.id && existing.key === summary.key) { existing.close(); this.activeHandles.delete(existing); }
    }
    const handle = new AgentHandle(this.transport, summary, localTools);
    this.activeHandles.add(handle);
    return handle;
  }

  private async requestRaw(method: string, path: string, init?: { headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<ResponseLike> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(init?.headers ?? {}) },
      ...(init?.body !== undefined ? { body: init.body } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    if (!res.ok) await throwHttpError(res, path);
    return res;
  }

  private async requestJson<T>(method: string, path: string, body?: unknown, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<T> {
    const headers: Record<string, string> = { ...(init?.headers ?? {}) };
    const encoded = body !== undefined ? ((headers["Content-Type"] = "application/json"), JSON.stringify(body)) : undefined;
    const res = await this.requestRaw(method, path, { headers, body: encoded, signal: init?.signal });
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  }
}
