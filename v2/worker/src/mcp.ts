import { toolImageContent } from "./tool-images.ts";
import { z } from "zod";
import { signToolIdentity, type ToolCallIdentity } from "./tool-identity.ts";
import { ApiError, type AgentConfig, type Env, type LlmToolSchema, type McpServerSpec } from "./types.ts";

type McpIdentity = { env: Env; agent: AgentConfig; call?: ToolCallIdentity };

const elicitationRequestSchema = z.object({
  method: z.literal("elicitation/create"),
  params: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("form"),
      message: z.string(),
      requestedSchema: z.record(z.string(), z.unknown()),
    }),
    z.object({
      mode: z.literal("url"),
      message: z.string(),
      url: z.url({ protocol: /^https$/ }),
      elicitationId: z.string(),
    }),
  ]),
});
const inputRequestSchema = z.discriminatedUnion("method", [
  elicitationRequestSchema,
  z.object({ method: z.literal("agent-runtime/approval") }),
]);

export class McpInputRequired extends Error {
  readonly key: string;
  readonly input: z.infer<typeof inputRequestSchema>;
  readonly requestState?: string;

  constructor(
    key: string,
    input: z.infer<typeof inputRequestSchema>,
    requestState?: string,
  ) {
    super("MCP tool is waiting for input");
    this.key = key;
    this.input = input;
    this.requestState = requestState;
  }
}

export type McpInputResponse = { key: string; requestState?: string; response: { action: "accept" | "decline"; content?: unknown } };

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

async function mcpRpcCall(
  server: McpServerSpec,
  method: string,
  params: Record<string, unknown>,
  identity: McpIdentity,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(server.headers ?? {}),
  });
  if (server.auth) {
    if (server.auth.type !== "runtime") throw new ApiError(400, "invalid_tool_auth", "Unsupported MCP authentication");
    const url = new URL(server.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) {
      throw new ApiError(400, "invalid_tool_url", "Signed runtime tools require HTTPS");
    }
    const audience = server.audience ?? `${url.origin}${url.pathname}`;
    headers.set("Authorization", `Bearer ${await signToolIdentity(identity.env, identity.agent, audience, identity.call)}`);
  }

  const res = await fetch(server.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
    signal,
    ...(server.auth ? { redirect: "manual" as const } : {}),
  });

  if (server.auth && res.status >= 300 && res.status < 400) {
    throw new Error(`Signed MCP server '${server.name}' returned a redirect`);
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MCP server '${server.name}' HTTP ${res.status}: ${errText}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  let rpc: JsonRpcResponse | null = null;
  const raw = await res.text();

  if (ct.includes("text/event-stream")) {
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        const candidate = line.slice(5).trim();
        if (!candidate || candidate === "[DONE]") continue;
        try {
          const parsed = JSON.parse(candidate) as JsonRpcResponse;
          if (parsed.result || parsed.error) {
            rpc = parsed;
          }
        } catch {
          // ignore partial frames
        }
      }
    }
  } else {
    rpc = JSON.parse(raw) as JsonRpcResponse;
  }

  if (!rpc) {
    throw new Error(`MCP server '${server.name}' returned empty JSON-RPC response`);
  }
  if (rpc.error) {
    throw new Error(`MCP error (${rpc.error.code ?? -1}): ${rpc.error.message ?? "unknown"}`);
  }
  return rpc.result ?? {};
}

export interface DiscoveredMcpTool {
  qualifiedName: string;
  remoteName: string;
  server: McpServerSpec;
  schema: LlmToolSchema;
}

export async function discoverMcpTools(
  env: Env,
  agent: AgentConfig,
  signal?: AbortSignal,
): Promise<DiscoveredMcpTool[]> {
  const servers = agent.mcpServers;
  if (!servers || servers.length === 0) return [];
  const discovered: DiscoveredMcpTool[] = [];

  await Promise.all(
    servers.map(async (server) => {
      try {
        const result = await mcpRpcCall(server, "tools/list", {}, { env, agent }, signal);
        const tools = Array.isArray(result.tools) ? result.tools : [];
        for (const rawTool of tools) {
          if (!rawTool || typeof rawTool !== "object") continue;
          const t = rawTool as {
            name?: string;
            description?: string;
            inputSchema?: Record<string, unknown>;
          };
          if (!t.name || (server.allowTools && !server.allowTools.includes(t.name))) continue;
          const qualifiedName = `${server.name}__${t.name}`;
          discovered.push({
            qualifiedName,
            remoteName: t.name,
            server,
            schema: {
              name: qualifiedName,
              description: t.description || `MCP tool ${t.name} from ${server.name}`,
              parameters: t.inputSchema ?? { type: "object", properties: {} },
            },
          });
        }
      } catch (error) {
        if (server.auth) throw error;
        // Non-fatal: unreachable MCP servers should not break the entire turn if unused
      }
    }),
  );

  return discovered;
}

export async function invokeMcpTool(
  tool: DiscoveredMcpTool,
  args: Record<string, unknown>,
  identity: McpIdentity,
  signal?: AbortSignal,
  input?: McpInputResponse,
): Promise<unknown> {
  const call = identity.call;
  const result = await mcpRpcCall(
    tool.server,
    "tools/call",
    {
      name: tool.remoteName,
      arguments: args,
      ...(call && tool.server.auth ? { _meta: {
        "agent-runtime/callId": crypto.randomUUID(),
        "agent-runtime/toolCallId": call.callId,
        "agent-runtime/idempotencyKey": JSON.stringify([identity.agent.id, call.runId, call.callId]),
        "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {}, url: {} } },
      } } : {}),
      ...(input ? { inputResponses: { [input.key]: input.response }, requestState: input.requestState } : {}),
    },
    identity,
    signal,
  );
  if (result.resultType === "input_required") {
    const requests = Object.entries(z.record(z.string(), inputRequestSchema).parse(result.inputRequests));
    const entry = requests[0];
    if (!tool.server.auth || requests.length !== 1 || !entry) {
      throw new Error(`MCP tool '${tool.remoteName}' returned an unsupported input request`);
    }
    const state = z.string().max(65_536).optional().parse(result.requestState);
    throw new McpInputRequired(entry[0], entry[1], state);
  }
  if (Array.isArray(result.content)) {
    const texts = (result.content as Array<{ type?: string; text?: string }>)
      .filter((c) => typeof c.text === "string")
      .map((c) => c.text!);
    if (result.isError) {
      throw new Error(texts.join("\n") || "MCP tool returned error");
    }
    if (toolImageContent(result)) return result;
    if (texts.length === 1) {
      try {
        return JSON.parse(texts[0]!);
      } catch {
        return texts[0]!;
      }
    }
    if (texts.length > 1) return texts.join("\n");
  }
  return result;
}
