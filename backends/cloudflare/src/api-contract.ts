import { BadRequest, object } from "./validation.ts";

export interface AgentConfiguration {
  model?: string;
  systemPrompt?: string;
  fileTools?: boolean;
  codeMode?: boolean;
  name?: string;
  type?: string;
  thinkingLevel?: string;
}
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string, code = "INVALID_REQUEST") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function agentToken(secret: string, id: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`camelrun-cloudflare:agent:${id}`));
  return `cat_${[...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function configuration(input: unknown, defaultModel: string): { config: AgentConfiguration; ttlSeconds?: number | null } {
  const fields = object(input, ["model", "systemPrompt", "fileTools", "codeMode", "name", "type", "thinkingLevel", "mcp", "ttlSeconds"]);
  if (fields.mcp !== undefined) {
    const mcp = object(fields.mcp, ["tools"]);
    if (!Array.isArray(mcp.tools) || mcp.tools.length !== 0) throw new ApiError(400, "Attached tools are not supported by the Cloudflare backend yet", "UNSUPPORTED_FEATURE");
  }
  const config: AgentConfiguration = { model: defaultModel };
  for (const field of ["model", "systemPrompt", "name", "type", "thinkingLevel"] as const) {
    if (fields[field] === undefined) continue;
    if (typeof fields[field] !== "string" || new TextEncoder().encode(fields[field] as string).length > 24 * 1024) throw new BadRequest(`${field} must be bounded text`);
    config[field] = fields[field] as string;
  }
  if (!config.model?.trim()) throw new BadRequest("model must be nonempty");
  for (const field of ["fileTools", "codeMode"] as const) {
    if (fields[field] !== undefined && typeof fields[field] !== "boolean") throw new BadRequest(`${field} must be a boolean`);
    if (fields[field] !== undefined) config[field] = fields[field] as boolean;
  }
  if (config.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(config.thinkingLevel)) throw new BadRequest("Invalid thinkingLevel");
  const ttlSeconds = fields.ttlSeconds;
  if (ttlSeconds !== undefined && ttlSeconds !== null) throw new ApiError(400, "Automatic expiry is not implemented; use a keyed agent or ttlSeconds: null", "UNSUPPORTED_FEATURE");
  return { config, ttlSeconds: ttlSeconds as number | null | undefined };
}
