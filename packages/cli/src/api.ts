import { createHash } from "node:crypto";

/** A refused call: the runtime's `error` message, with the HTTP status and its `code` when it gave one. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code; }
}

export interface Credentials { url: string; apiKey: string }

/** The runtime's REST API, called with a tenant API key (`art_…`). */
export class Api {
  readonly url: string;
  private readonly apiKey: string;
  private readonly fetch: typeof globalThis.fetch;
  private tenant?: Promise<string>;
  constructor(credentials: Credentials, fetch = globalThis.fetch) {
    this.url = credentials.url.replace(/\/+$/, "");
    this.apiKey = credentials.apiKey;
    this.fetch = fetch;
  }

  async call<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.fetch(this.url + path, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, "User-Agent": "camelrun", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    if (!response.ok) {
      const message = json?.error ?? json?.message ?? (text.slice(0, 300) || response.statusText);
      throw new ApiError(response.status, response.status === 401 ? `${message} (check your API key: camelrun login)` : message, json?.code);
    }
    return json as T;
  }
  get<T = any>(path: string) { return this.call<T>("GET", path); }
  /** A public document of the runtime's (its docs), as text. */
  async text(path: string) {
    const response = await this.fetch(this.url + path);
    if (!response.ok) throw new ApiError(response.status, `${path}: ${response.status === 404 ? "no such page (read_docs with no path lists them)" : response.statusText}`);
    return response.text();
  }

  me(): Promise<{ tenant: string; via: string; login?: string; defaultModel: string }> { return this.get("/v1/me"); }

  /** A definition's id from its key: the runtime derives it from the tenant and the key. */
  async definitionId(keyOrId: string) {
    if (/^def_[a-f0-9]{20}$/.test(keyOrId)) return keyOrId;
    this.tenant ??= this.me().then(me => me.tenant);
    return `def_${createHash("sha256").update(`${await this.tenant}:${keyOrId}`).digest("hex").slice(0, 20)}`;
  }

  /** An agent's id from its key or id (`client_…`). */
  async agentId(keyOrId: string) {
    if (keyOrId.startsWith("client_")) return keyOrId;
    const agents = await this.get<{ id: string; key: string | null }[]>("/v1/agents");
    const found = agents.find(agent => agent.key === keyOrId);
    if (!found) throw new ApiError(404, `No agent with key ${JSON.stringify(keyOrId)} (camelrun agents list shows them)`);
    return found.id;
  }
}

export const enc = encodeURIComponent;
