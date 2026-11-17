import type { LlmToolSchema, McpServerSpec } from "./types.ts";

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
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(server.headers ?? {}),
  };

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
  });

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
  servers: McpServerSpec[],
  signal?: AbortSignal,
): Promise<DiscoveredMcpTool[]> {
  if (!servers || servers.length === 0) return [];
  const discovered: DiscoveredMcpTool[] = [];

  await Promise.all(
    servers.map(async (server) => {
      try {
        const result = await mcpRpcCall(server, "tools/list", {}, signal);
        const tools = Array.isArray(result.tools) ? result.tools : [];
        for (const rawTool of tools) {
          if (!rawTool || typeof rawTool !== "object") continue;
          const t = rawTool as {
            name?: string;
            description?: string;
            inputSchema?: Record<string, unknown>;
          };
          if (!t.name) continue;
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
      } catch {
        // Non-fatal: unreachable MCP servers should not break the entire turn if unused
      }
    }),
  );

  return discovered;
}

export async function invokeMcpTool(
  tool: DiscoveredMcpTool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = await mcpRpcCall(
    tool.server,
    "tools/call",
    {
      name: tool.remoteName,
      arguments: args,
    },
    signal,
  );
  if (Array.isArray(result.content)) {
    const texts = (result.content as Array<{ type?: string; text?: string }>)
      .filter((c) => typeof c.text === "string")
      .map((c) => c.text!);
    if (result.isError) {
      throw new Error(texts.join("\n") || "MCP tool returned error");
    }
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
