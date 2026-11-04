import { CamelAgent, json, type Env } from "./agent.ts";
import { AgentDirectory, ApiError, agentToken, configuration, type DirectoryEntry, type DirectoryFailure } from "./directory.ts";
import { authorized, agentId, BadRequest, body } from "./validation.ts";
export { CamelAgent, AgentDirectory };
export { ContainerComputer, SandboxComputer } from "./computers/objects.ts";
export { DirectoryBackupGateway } from "@cloudflare/sandbox";

type WorkerEnv = Env & { DIRECTORY: DurableObjectNamespace<AgentDirectory> };
function result<T>(value: T | DirectoryFailure): T {
  if (value !== null && typeof value === "object" && "failed" in value && value.failed === true) {
    const error = value as DirectoryFailure;
    throw new ApiError(error.status, error.error, error.code);
  }
  return value as T;
}

function credentials(entry: DirectoryEntry, token: string) {
  return { id: entry.id, token, expiresAt: entry.expiresAt, configHash: entry.configHash };
}
function summary(entry: DirectoryEntry) {
  return {
    id: entry.id, key: entry.key, name: entry.config.name ?? "", type: entry.config.type ?? "agent",
    model: entry.config.model, connected: false, running: false, expiresAt: entry.expiresAt,
    configHash: entry.configHash, resume: null,
  };
}
async function forward(request: Request, env: WorkerEnv, id: string, path: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = path;
  return env.AGENTS.getByName(id).fetch(new Request(url, request));
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      const operator = await authorized(request, env.API_TOKEN);
      const directory = env.DIRECTORY.getByName("prototype");
      if (url.pathname === "/healthz" && request.method === "GET") {
        if (!operator) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");
        return json({ ok: true, backend: "cloudflare", experimental: true });
      }
      if (url.pathname === "/v1/agents") {
        if (!operator) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");
        if (request.method === "GET") return json((await directory.list()).map(summary));
        if (request.method === "POST") {
          const input = await body(request);
          configuration(input, env.MODEL);
          const key = request.headers.get("Idempotency-Key") ?? undefined;
          if (key && !/^[A-Za-z0-9_-]{1,80}$/.test(key)) throw new BadRequest("Invalid Idempotency-Key");
          if (key) {
            const previous = await directory.get(key);
            if (previous?.deleted) throw new ApiError(410, "Agent is deleted", "AGENT_GONE");
          }
          const entry = result<DirectoryEntry>(await directory.upsert(input, key));
          return json(credentials(entry, await agentToken(env.API_TOKEN, entry.id)), 201);
        }
        throw new ApiError(405, "Method not allowed", "METHOD_NOT_ALLOWED");
      }
      const match = /^\/(clients|v1\/agents|experimental\/agents)\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (!match) throw new ApiError(404, "Unknown backend route", "NOT_FOUND");
      const idOrKey = agentId(decodeURIComponent(match[2]));
      const entry = await directory.get(idOrKey);
      if (!entry) {
        if (!operator) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");
        throw new ApiError(404, "Unknown agent", "AGENT_NOT_FOUND");
      }
      const scoped = await authorized(request, await agentToken(env.API_TOKEN, entry.id));
      if (!operator && !scoped) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");
      const path = match[3] || "/";
      // The operator can retry cleanup after revocation; every other access stays revoked.
      if (entry.deleted) {
        if (operator && path === "/" && request.method === "DELETE") {
          result(await directory.remove(entry.id));
          return json({ deleted: true });
        }
        throw new ApiError(match[1] === "clients" ? 410 : 404, "Agent is deleted", "AGENT_GONE");
      }
      if (!entry.initialized) throw new ApiError(503, "Agent initialization is pending; retry creation", "INITIALIZATION_PENDING");
      if (match[1] === "v1/agents" && path === "/credentials" && request.method === "GET") {
        if (!operator) throw new ApiError(403, "Operator credentials required", "FORBIDDEN");
        return json(credentials(entry, await agentToken(env.API_TOKEN, entry.id)));
      }
      if (path === "/" && request.method === "DELETE") {
        result(await directory.remove(entry.id));
        return json({ deleted: true });
      }
      if (match[1] === "v1/agents" && path === "/" && request.method === "GET") return json(summary(entry));

      if (path === "/mounts" && request.method === "GET") return json([{ path: "/workspace", mode: "rw", workspace: true }]);
      if (path === "/configuration") {
        if (request.method === "GET") return json(entry.config);
        throw new ApiError(501, "Change configuration through keyed agent upsert", "UNSUPPORTED_FEATURE");
      }
      if (match[1] === "experimental/agents") {
        if (!["/exec", "/computer", "/state", "/events", "/inputs"].includes(path) && !path.startsWith("/files/") && !path.startsWith("/inputs/")) throw new ApiError(404, "Unknown experimental route", "NOT_FOUND");
        return await forward(request, env, entry.id, path);
      }
      if (!["/state", "/events", "/requests", "/history", "/configuration", "/abort", "/inputs"].includes(path) && !path.startsWith("/requests/") && !path.startsWith("/files/")) {
        throw new ApiError(501, "This feature is not implemented by the Cloudflare backend", "UNSUPPORTED_FEATURE");
      }
      return await forward(request, env, entry.id, path);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof BadRequest || error instanceof URIError) return json({ error: error.message, code: "INVALID_REQUEST" }, 400);
      if ((error as { code?: string })?.code === "ENOENT") return json({ error: "File not found", code: "NOT_FOUND" }, 404);
      return json({ error: "Backend operation failed", code: "BACKEND_ERROR" }, 500);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
