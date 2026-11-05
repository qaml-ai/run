import { BadRequest, object } from "./validation.ts";

export interface AgentConfiguration {
  model?: string;
  systemPrompt?: string;
  fileTools?: boolean;
  codeMode?: boolean;
  name?: string;
  type?: string;
  thinkingLevel?: string;
  builtins?: string[];
  delegate?: { agents?: string[] };
  mounts?: {
    volumeId: string;
    path: string;
    mode: "rw" | "ro";
    subpath?: string;
  }[];
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
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function agentToken(secret: string, id: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`camelrun-cloudflare:agent:${id}`),
  );
  return `cat_${[...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function configuration(
  input: unknown,
  defaultModel: string,
): { config: AgentConfiguration; ttlSeconds?: number | null } {
  const fields = object(input, [
    "model",
    "systemPrompt",
    "fileTools",
    "codeMode",
    "name",
    "type",
    "thinkingLevel",
    "mcp",
    "ttlSeconds",
    "builtins",
    "delegate",
    "mounts",
  ]);
  if (fields.mcp !== undefined) {
    const mcp = object(fields.mcp, ["tools"]);
    if (!Array.isArray(mcp.tools) || mcp.tools.length !== 0)
      throw new ApiError(
        400,
        "Attached tools are not supported by the Cloudflare backend yet",
        "UNSUPPORTED_FEATURE",
      );
  }
  const config: AgentConfiguration = { model: defaultModel };
  for (const field of [
    "model",
    "systemPrompt",
    "name",
    "type",
    "thinkingLevel",
  ] as const) {
    if (fields[field] === undefined) continue;
    if (
      typeof fields[field] !== "string" ||
      new TextEncoder().encode(fields[field] as string).length > 24 * 1024
    )
      throw new BadRequest(`${field} must be bounded text`);
    config[field] = fields[field] as string;
  }
  if (!config.model?.trim()) throw new BadRequest("model must be nonempty");
  for (const field of ["fileTools", "codeMode"] as const) {
    if (fields[field] !== undefined && typeof fields[field] !== "boolean")
      throw new BadRequest(`${field} must be a boolean`);
    if (fields[field] !== undefined) config[field] = fields[field] as boolean;
  }
  if (
    config.thinkingLevel !== undefined &&
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      config.thinkingLevel,
    )
  )
    throw new BadRequest("Invalid thinkingLevel");
  if (fields.builtins !== undefined) {
    if (
      !Array.isArray(fields.builtins) ||
      fields.builtins.some(
        (x) =>
          typeof x !== "string" ||
          !["ask_user", "ask_human", "delegate", "agents", "schedule"].includes(
            x,
          ),
      )
    )
      throw new BadRequest("Unsupported builtin");
    config.builtins = fields.builtins as string[];
  }
  if (fields.delegate !== undefined) {
    const delegate = object(fields.delegate, ["agents"]);
    if (
      delegate.agents !== undefined &&
      (!Array.isArray(delegate.agents) ||
        delegate.agents.some((x) => typeof x !== "string"))
    )
      throw new BadRequest("delegate.agents must be strings");
    config.delegate = delegate as { agents?: string[] };
  }
  if (fields.mounts !== undefined) {
    if (!Array.isArray(fields.mounts) || fields.mounts.length > 20)
      throw new BadRequest("At most 20 mounts");
    config.mounts = fields.mounts.map((raw) => {
      const mount = object(raw, ["volumeId", "path", "mode", "subpath"]);
      if (
        typeof mount.volumeId !== "string" ||
        typeof mount.path !== "string" ||
        !mount.path.startsWith("/") ||
        mount.path.split("/").some((x) => x === ".." || x === ".") ||
        !["rw", "ro"].includes(String(mount.mode))
      )
        throw new BadRequest("Invalid mount");
      return mount as {
        volumeId: string;
        path: string;
        mode: "rw" | "ro";
        subpath?: string;
      };
    });
  }
  const ttlSeconds = fields.ttlSeconds;
  if (
    ttlSeconds !== undefined &&
    ttlSeconds !== null &&
    (!Number.isInteger(ttlSeconds) ||
      Number(ttlSeconds) < 1 ||
      Number(ttlSeconds) > 30 * 86400)
  )
    throw new BadRequest("ttlSeconds must be 1 to 2592000 or null");
  return { config, ttlSeconds: ttlSeconds as number | null | undefined };
}
