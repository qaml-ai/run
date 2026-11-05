import { agentToolView } from "./agent-tool-view.ts";
import type { Directory, AuthContext, ControlEnv, DirectoryEntry } from "./control.ts";
import { authenticationHint } from "./public-http.ts";

const response = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { "cache-control": "no-store" },
});
const error = (status: number, message: string, code: string) => response({ type: "error", error: message, code }, status);

function metadata(entry: DirectoryEntry) {
  return {
    id: entry.id, key: entry.key, name: entry.config.name ?? "", type: entry.config.type ?? "agent",
    model: entry.config.model, configHash: entry.configHash, expiresAt: entry.expiresAt,
    connected: false, running: false, resume: null,
    workspaceId: null, lastActiveAt: null, lastError: null,
  };
}

/** The operator bridge from src/node.ts: account-only, never browser Origin
 * requests, and tenant ownership is checked before touching an agent object.
 * Request execution continues through the ordinary durable request handler. */
export async function handleServiceRequest(
  request: Request,
  env: ControlEnv,
  auth: AuthContext | null,
  directory?: Pick<Directory, "list" | "get">,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/registry" && !path.startsWith("/registry/")) return null;
  if (!auth) return error(401, authenticationHint(request, env.AGENT_PUBLIC_URL || new URL(request.url).origin), "UNAUTHORIZED");
  if (request.headers.has("origin")) return new Response(null, { status: 403 });
  const registry = directory ?? new (await import("./control.ts")).Directory(env, auth.tenantId);
  if (path === "/registry") {
    if (request.method !== "GET") return error(405, "Method not allowed", "METHOD_NOT_ALLOWED");
    return response((await registry.list()).map(metadata));
  }
  const match = /^\/registry\/(client_[a-f0-9]{40})(\/requests)?$/.exec(path);
  if (!match) return error(404, "Not found", "NOT_FOUND");
  const bridge = !!match[2];
  if (request.method !== (bridge ? "POST" : "GET")) return error(405, "Method not allowed", "METHOD_NOT_ALLOWED");
  const entry = await registry.get(match[1]);
  if (!entry) return bridge ? error(401, "Unauthorized", "UNAUTHORIZED") : error(404, "Agent not found", "AGENT_NOT_FOUND");
  if (entry.deleted || (entry.expiresAt !== null && entry.expiresAt <= Date.now()))
    return bridge ? error(410, "Session expired or revoked", "AGENT_GONE") : error(404, "Agent not found", "AGENT_NOT_FOUND");
  if (!entry.initialized) return error(503, "Agent initialization is pending", "INITIALIZATION_PENDING");
  const agent = env.AGENTS.getByName(entry.id);
  if (bridge) {
    const url = new URL(request.url);
    url.pathname = "/requests";
    return agent.fetch(new Request(url, request));
  }
  const stateResponse = await agent.fetch(new Request("https://agent/state"));
  if (!stateResponse.ok) return stateResponse;
  const state = await stateResponse.json() as { cursor: number; requests: { state: string }[] };
  const config = entry.config;
  return response({
    ...metadata(entry), tools: agentToolView(config), systemPrompt: config.systemPrompt ?? "",
    ...(config.fileTools === false ? { fileTools: false } : {}),
    ...(config.codeMode === false ? { codeMode: false } : {}),
    mounts: config.mounts ?? [], keyScope: null, bucket: null, modelHeaders: null,
    builtins: config.builtins ?? [], delegate: config.delegate ?? null,
    workflow: null, mcpServers: [], decide: null, spendLimit: null, runLimits: null,
    maxOutputTokens: null, temperature: null, dataCollection: null, language: null,
    cursor: state.cursor, requests: state.requests,
    running: state.requests.some(record => record.state === "running"),
  });
}
