import { mintCamelfsToken } from "./crypto.ts";
import { ApiError, type Env } from "./types.ts";

export interface CamelFsLineageInfo {
  lineage: string;
  defaultRef?: string;
  ref?: string;
  commit: string;
  tree: string;
}

export interface CamelFsRefInfo {
  name: string;
  commit: string;
  tree: string;
  updatedAt: number;
  lease?: {
    holder: string;
    epoch: number;
    expiresAt: number;
  } | null;
}

export interface CamelFsWriteRequest {
  ref: string;
  expectedCommit?: string;
  holder?: string;
  author?: string;
  message?: string;
  puts?: Array<{
    path: string;
    content?: string;
    base64?: string;
    mode?: number;
  }>;
  deletes?: string[];
  moves?: Array<{ from: string; to: string }>;
}

export interface CamelFsWriteResponse {
  commit: string;
  tree: string;
  changed: string[];
  totalBytes: number;
}

export interface CamelFsReadResponse {
  commit: string;
  path: string;
  size: number;
  mode: number;
  binary: boolean;
  content: string | null;
  base64: string | null;
}

export interface CamelFsLsEntry {
  path: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mode: number;
  hash: string;
}

export interface CamelFsLsResponse {
  commit: string;
  entries: CamelFsLsEntry[];
}

export interface CamelFsGrepMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface CamelFsGrepResponse {
  commit: string;
  matches: CamelFsGrepMatch[];
}

export interface CamelFsCommitInfo {
  commit: string;
  tree: string;
  parents: string[];
  author: string;
  message: string;
  createdAt: number;
}

export interface CamelFsVmInfo {
  vmId: string;
  lineage: string;
  ref: string;
  holder: string;
  state: "running" | "stopped" | "lost";
  headCommit: string;
  reused?: boolean;
  leaseExpiresAt: number;
}

export interface CamelFsVmExecRequest {
  execId: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutS?: number;
  commit?: {
    author?: string;
    message?: string;
    skip?: boolean;
  };
}

export interface CamelFsVmExecResult {
  execId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  cwd: string;
  timedOut: boolean;
  durationMs: number;
  billableMs: number;
  commit: {
    changed: boolean;
    commit: string;
    tree: string;
    filesChanged: string[];
  };
}

export class CamelFsClient {
  private readonly baseUrl: string;
  private readonly env: Pick<Env, "CAMELFS_URL" | "CAMELFS_SIGNING_KEY" | "CAMELFS_DEV_TOKEN">;
  private readonly tenantId: string;

  constructor(
    env: Pick<Env, "CAMELFS_URL" | "CAMELFS_SIGNING_KEY" | "CAMELFS_DEV_TOKEN">,
    tenantId: string,
  ) {
    this.env = env;
    this.baseUrl = (env.CAMELFS_URL || "http://127.0.0.1:8790").replace(/\/+$/, "");
    this.tenantId = tenantId;
  }

  private async request<T>(
    method: string,
    path: string,
    options?: {
      lineage?: string;
      scopes?: string[];
      query?: Record<string, string | number | boolean | undefined | null>;
      body?: unknown;
    },
  ): Promise<T> {
    const token = await mintCamelfsToken(
      this.env,
      this.tenantId,
      options?.lineage ?? "*",
      options?.scopes ?? ["repo:read", "repo:write", "vm:exec"],
    );

    const url = new URL(`${this.baseUrl}${path}`);
    if (options?.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-Camel-Tenant": this.tenantId,
    };
    let bodyStr: string | undefined;
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(options.body);
    }

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: bodyStr,
    });

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!res.ok) {
      const errObj =
        parsed && typeof parsed === "object" && "error" in parsed
          ? (parsed as { error?: { code?: string; message?: string } }).error
          : undefined;
      const code = errObj?.code ?? `camelfs_${res.status}`;
      const message = errObj?.message ?? (text || `camelfsd HTTP ${res.status}`);
      throw new ApiError(res.status, code, message);
    }

    return parsed as T;
  }

  async healthz(): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/healthz`);
    if (!res.ok) {
      throw new ApiError(res.status, "camelfs_unhealthy", `camelfsd healthz returned ${res.status}`);
    }
    return (await res.json()) as { ok: boolean };
  }

  async createLineage(lineage?: string): Promise<{
    lineage: string;
    defaultRef: string;
    commit: string;
    tree: string;
  }> {
    return this.request("POST", "/v1/lineages", {
      lineage: lineage ?? "*",
      scopes: ["repo:write"],
      body: { lineage, tenantId: this.tenantId },
    });
  }

  async deleteLineage(lineage: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/v1/lineages/${encodeURIComponent(lineage)}`, {
      lineage,
      scopes: ["repo:write", "vm:exec"],
    });
  }

  async forkLineage(
    lineage: string,
    opts?: {
      targetLineage?: string;
      sourceRef?: string;
      targetRef?: string;
      atCommit?: string;
    },
  ): Promise<{ lineage: string; ref: string; commit: string; tree: string }> {
    return this.request("POST", `/v1/lineages/${encodeURIComponent(lineage)}/fork`, {
      lineage: "*",
      scopes: ["repo:read", "repo:write"],
      body: opts ?? {},
    });
  }

  async listRefs(lineage: string, prefix?: string): Promise<{ refs: CamelFsRefInfo[] }> {
    return this.request("GET", `/v1/lineages/${encodeURIComponent(lineage)}/refs`, {
      lineage,
      scopes: ["repo:read"],
      query: { prefix },
    });
  }

  async updateRef(
    lineage: string,
    req: {
      ref: string;
      commit?: string;
      expectedCommit?: string;
      holder?: string;
      delete?: boolean;
    },
  ): Promise<{ ref: string; commit: string; tree: string }> {
    return this.request("POST", `/v1/lineages/${encodeURIComponent(lineage)}/refs`, {
      lineage,
      scopes: ["repo:write"],
      body: req,
    });
  }

  async leaseRef(
    lineage: string,
    req: { ref: string; holder: string; ttlMs?: number; release?: boolean },
  ): Promise<{
    ref: string;
    commit: string;
    tree: string;
    holder: string;
    epoch: number;
    expiresAt: number;
  }> {
    return this.request("POST", `/v1/lineages/${encodeURIComponent(lineage)}/lease`, {
      lineage,
      scopes: ["repo:write"],
      body: {
        ref: req.ref,
        holder: req.holder,
        ttlMs: req.ttlMs ?? 600_000,
        ...(req.release !== undefined ? { release: req.release } : {}),
      },
    });
  }

  async write(lineage: string, req: CamelFsWriteRequest): Promise<CamelFsWriteResponse> {
    return this.request("POST", `/v1/lineages/${encodeURIComponent(lineage)}/write`, {
      lineage,
      scopes: ["repo:write"],
      body: req,
    });
  }

  async read(
    lineage: string,
    params: { at?: string; path: string; offset?: number; limit?: number },
  ): Promise<CamelFsReadResponse> {
    return this.request("GET", `/v1/lineages/${encodeURIComponent(lineage)}/read`, {
      lineage,
      scopes: ["repo:read"],
      query: {
        at: params.at ?? "refs/heads/main",
        path: normalizeRepoPath(params.path),
        offset: params.offset,
        limit: params.limit,
      },
    });
  }

  async ls(
    lineage: string,
    params?: { at?: string; path?: string; recursive?: boolean | number; glob?: string },
  ): Promise<CamelFsLsResponse> {
    return this.request("GET", `/v1/lineages/${encodeURIComponent(lineage)}/ls`, {
      lineage,
      scopes: ["repo:read"],
      query: {
        at: params?.at ?? "refs/heads/main",
        path: params?.path ? normalizeRepoPath(params.path) : "",
        recursive: params?.recursive ? 1 : undefined,
        glob: params?.glob,
      },
    });
  }

  async grep(
    lineage: string,
    req: { at?: string; pattern: string; pathPrefix?: string; maxMatches?: number },
  ): Promise<CamelFsGrepResponse> {
    return this.request("POST", `/v1/lineages/${encodeURIComponent(lineage)}/grep`, {
      lineage,
      scopes: ["repo:read"],
      body: {
        at: req.at ?? "refs/heads/main",
        pattern: req.pattern,
        pathPrefix: req.pathPrefix ? normalizeRepoPath(req.pathPrefix) : undefined,
        maxMatches: req.maxMatches ?? 100,
      },
    });
  }

  async history(
    lineage: string,
    params?: { ref?: string; limit?: number },
  ): Promise<{ commits: CamelFsCommitInfo[] }> {
    return this.request("GET", `/v1/lineages/${encodeURIComponent(lineage)}/history`, {
      lineage,
      scopes: ["repo:read"],
      query: {
        ref: params?.ref ?? "refs/heads/main",
        limit: params?.limit ?? 20,
      },
    });
  }

  async restore(
    lineage: string,
    req: {
      ref: string;
      targetCommit: string;
      expectedCommit?: string;
      holder?: string;
      author?: string;
      message?: string;
    },
  ): Promise<{ commit: string; tree: string }> {
    return this.request("POST", `/v1/lineages/${encodeURIComponent(lineage)}/restore`, {
      lineage,
      scopes: ["repo:write"],
      body: req,
    });
  }

  async ensureVm(req: {
    lineage: string;
    ref: string;
    holder: string;
    vcpus?: number;
    memoryMiB?: number;
    idleTimeoutS?: number;
    leaseS?: number;
    env?: Record<string, string>;
  }): Promise<CamelFsVmInfo> {
    return this.request("POST", "/v1/vms", {
      lineage: req.lineage,
      scopes: ["repo:read", "repo:write", "vm:exec"],
      body: {
        vcpus: 2,
        memoryMiB: 2048,
        idleTimeoutS: 60,
        leaseS: 600,
        ...req,
      },
    });
  }

  async execVm(
    vmId: string,
    lineage: string,
    req: CamelFsVmExecRequest,
  ): Promise<CamelFsVmExecResult> {
    return this.request("POST", `/v1/vms/${encodeURIComponent(vmId)}/exec`, {
      lineage,
      scopes: ["repo:read", "repo:write", "vm:exec"],
      body: req,
    });
  }

  async leaseVm(
    vmId: string,
    lineage: string,
    leaseS = 600,
  ): Promise<{ vmId: string; state: string; leaseExpiresAt: number }> {
    return this.request("POST", `/v1/vms/${encodeURIComponent(vmId)}/lease`, {
      lineage,
      scopes: ["vm:exec"],
      body: { leaseS },
    });
  }

  async stopVm(
    vmId: string,
    lineage = "*",
  ): Promise<{ vmId: string; state: string; commit: string; unbilledMs: number }> {
    return this.request("POST", `/v1/vms/${encodeURIComponent(vmId)}/stop`, {
      lineage,
      scopes: ["repo:write", "vm:exec"],
      body: {},
    });
  }

  async getVm(vmId: string, lineage = "*"): Promise<CamelFsVmInfo> {
    return this.request("GET", `/v1/vms/${encodeURIComponent(vmId)}`, {
      lineage,
      scopes: ["vm:exec"],
    });
  }
}

export function normalizeRepoPath(rawPath: string): string {
  let cleaned = rawPath.trim();
  if (cleaned.startsWith("/workspace/")) {
    cleaned = cleaned.slice("/workspace/".length);
  } else if (cleaned === "/workspace") {
    cleaned = "";
  }
  cleaned = cleaned.replace(/^\/+/, "");
  return cleaned;
}
