import {
  MCP_CLIENT_KINDS,
  MCP_CLIENT_LABELS,
  type McpClientKind,
} from "../../../shared/ops-types.ts";

export { MCP_CLIENT_KINDS, MCP_CLIENT_LABELS, type McpClientKind };

/** Classification uses OAuth registration metadata, never a user agent or a model name. */
export function mcpClientKind(clientName: string, redirectUris: readonly string[]): McpClientKind {
  for (const uri of redirectUris) {
    try {
      const url = new URL(uri);
      if (url.protocol !== "https:") continue;
      if (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") return "chatgpt";
      if (url.hostname === "claude.ai") return "claude";
    } catch {
      /* Malformed metadata supplies no host evidence. */
    }
  }
  switch (clientName.trim().toLowerCase()) {
    case "chatgpt":
      return "chatgpt";
    case "codex":
      return "codex";
    case "claude":
    case "claude code":
      return "claude";
    default:
      return "other";
  }
}
