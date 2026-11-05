import { BadRequest, object } from "./validation.ts";
import { identityInput, bucketInput, spendInput } from "./security-policy.ts";
import { checkScope } from "./key-scopes.ts";

export interface AgentConfiguration {
  subject?: string;
  context?: Record<string, unknown>;
  bucket?: string;
  keyScope?: string;
  spendLimit?: number;
  workspaceId?: string | null;
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
    notify?: boolean;
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
    "subject", "context", "bucket", "keyScope", "spendLimit", "workspaceId",
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
    "remount",
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
  Object.assign(config, identityInput(fields));
  if (fields.bucket !== undefined && fields.bucket !== null) config.bucket = bucketInput(fields.bucket);
  if (fields.keyScope !== undefined) config.keyScope = checkScope(fields.keyScope);
  if (fields.spendLimit !== undefined) {
    const spendLimit = spendInput(fields.spendLimit);
    if (spendLimit !== null) config.spendLimit = spendLimit;
  }
  if (fields.workspaceId !== undefined) {
    if (fields.workspaceId !== null && typeof fields.workspaceId !== 'string') throw new BadRequest('Invalid workspaceId');
    config.workspaceId = fields.workspaceId as string | null;
  }
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
    if (!Array.isArray(fields.mounts) || fields.mounts.length > 16)
      throw new BadRequest("At most 16 mounts");
    for(const raw of fields.mounts) {
      const mount=object(raw,["workspace","volumeId","path","mode","subpath","notify"]);
      if("workspace" in mount) {
        if(typeof mount.workspace!=="boolean"||Object.keys(mount).some(key=>key!=="workspace"&&(mount.workspace!==true||key!=="path")))throw new BadRequest("Invalid workspace mount");
      } else if(typeof mount.volumeId!=="string"||typeof mount.path!=="string"||!["rw","ro"].includes(String(mount.mode)))throw new BadRequest("Invalid mount");
    }
    // Ownership and the workspace marker are resolved by the directory before persistence.
    config.mounts=fields.mounts as AgentConfiguration["mounts"];
  }
  if(fields.remount!==undefined&&typeof fields.remount!=="boolean")throw new BadRequest("remount must be a boolean");
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
