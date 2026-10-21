/** Classification uses OAuth registration metadata, never a user agent or a model name. */
export type McpClientKind = "chatgpt" | "codex" | "claude" | "other";
export const MCP_CLIENT_KINDS: McpClientKind[] = ["chatgpt", "codex", "claude", "other"];
export const MCP_CLIENT_LABELS: Record<McpClientKind, string> = {
  chatgpt: "ChatGPT plugin", codex: "Codex plugin", claude: "Claude plugin", other: "Other MCP plugin",
};

export function mcpClientKind(clientName: string, redirectUris: readonly string[]): McpClientKind {
  for (const uri of redirectUris) {
    try {
      const url = new URL(uri);
      if (url.protocol !== "https:") continue;
      if (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") return "chatgpt";
      if (url.hostname === "claude.ai") return "claude";
    } catch { /* Malformed legacy metadata supplies no host evidence. */ }
  }
  switch (clientName.trim().toLowerCase()) {
    case "chatgpt": return "chatgpt";
    case "codex": return "codex";
    case "claude": case "claude code": return "claude";
    default: return "other";
  }
}

/** Only decode ids read from oauth_grants, which OAuth already validated. This is not token authentication. */
export function mcpGrantKind(clientName: string, clientId: string): McpClientKind {
  const payload = /^mcp_([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{32}$/.exec(clientId)?.[1];
  try {
    const metadata = payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) : null;
    return mcpClientKind(clientName, Array.isArray(metadata?.r) ? metadata.r.filter((uri: unknown) => typeof uri === "string") : []);
  } catch { return mcpClientKind(clientName, []); }
}
