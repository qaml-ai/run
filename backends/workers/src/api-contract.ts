import { BadRequest, object } from "./validation.ts";

import { languageInput } from "../../../src/language.ts";
import { dataCollectionInput, maxOutputTokensInput, modelHeadersInput, runLimitsInput, temperatureInput, type RunLimits } from "./model-policy.ts";
import { delegateInput, delegateSettings, type DelegateSettings } from "./multi-agent-policy.ts";
import { toPiMessages } from "./history-formats.ts";
import { validateInitialMessages } from "./history-policy.ts";
import type { ToolDefinition } from "./attached-tools.ts";
import { searchOrder } from "./web-search-policy.ts";
import { spendInput } from "./agent-spend-policy.ts";
import { identityInput, bucketInput } from "./security-policy.ts";
import { checkScope } from "./key-scopes.ts";
import { VOLUME_LIMITS } from "./volume-policy.ts";
import { attachmentMessages } from "./attachment-markers.ts";
import { humanInputSettings, type HumanInputSettings } from "./input-policy.ts";
import { workflowSettings, type WorkflowSettings } from "./workflow-policy.ts";

export interface AgentConfiguration {
  model?: string;
  systemPrompt?: string;
  systemPromptAppend?: string;
  fileTools?: boolean;
  codeMode?: boolean;
  name?: string;
  idleTtlSeconds?: number | null;
  type?: string;
  thinkingLevel?: string;
  maxOutputTokens?: number | null;
  temperature?: number | null;
  dataCollection?: "deny" | null;
  language?: string | null;
  modelHeaders?: Record<string, string> | null;
  runLimits?: RunLimits | null;
  builtins?: string[];
  webSearch?: { providers: string[] };
  delegate?: DelegateSettings;
  workflow?: WorkflowSettings;
  decide?: boolean;
  mcp?: { tools: ToolDefinition[] };
  mcpServers?: Record<string, unknown>[];
  openApi?: Record<string, unknown>[];
  initialMessages?: unknown[];
  definition?: string;
  definitionRevision?: number;
  definitionOverrides?: string[];
  subject?: string;
  context?: Record<string, unknown>;
  keyScope?: string;
  bucket?: string;
  spendLimit?: { usd: number } | null;
  workspaceId?: string | null;
  humanInput?: HumanInputSettings;
  subagents?: Record<string, unknown>;
  mounts?: { volumeId?: string; workspace?: boolean; path?: string; mode?: "rw" | "ro"; subpath?: string; notify?: boolean }[];
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

const BUILTINS = ["file_link", "file_import", "web_fetch", "web_search", "x_search", "schedule", "ask_user", "ask_human", "delegate", "generate_image", "agents", "decide", "workflow"];
export function configuration(input: unknown, defaultModel: string): { config: AgentConfiguration; ttlSeconds?: number | null } {
  let fields: Record<string, unknown>;
  try {
    fields = object(input, ["model", "systemPrompt", "systemPromptAppend", "fileTools", "codeMode", "name", "type", "thinkingLevel", "mcp", "ttlSeconds", "idleTtlSeconds", "builtins", "webSearch", "delegate", "workflow", "decide", "mounts", "maxOutputTokens", "temperature", "dataCollection", "language", "modelHeaders", "runLimits", "initialMessages", "importMessages", "definition", "subject", "context", "keyScope", "spendLimit", "bucket", "humanInput", "subagents", "workspaceId", "remount", "prompt", "mcpServers", "openApi", "definitionRevision", "definitionOverrides"]);
  } catch (error) {
    if (error instanceof BadRequest && error.message.startsWith("Unsupported field: "))
      throw new BadRequest(`Unknown agent field: ${error.message.slice("Unsupported field: ".length).split(", ")[0]}`);
    throw error;
  }
  const config: AgentConfiguration = { model: defaultModel };
  Object.assign(config, identityInput(fields));
  if (fields.bucket !== undefined && fields.bucket !== null) config.bucket = bucketInput(fields.bucket);
  if (fields.keyScope !== undefined) config.keyScope = checkScope(fields.keyScope);
  if (fields.workspaceId !== undefined) {
    if (fields.workspaceId !== null && typeof fields.workspaceId !== "string") throw new BadRequest("Invalid workspaceId");
    config.workspaceId = fields.workspaceId as string | null;
  }
  for (const field of ["model", "systemPrompt", "systemPromptAppend", "name", "type", "thinkingLevel", "definition"] as const) {
    if (fields[field] === undefined) continue;
    if (field === "model" && typeof fields[field] !== "string") throw new BadRequest('model must be a "provider/model-id" string');
    if (typeof fields[field] !== "string" || new TextEncoder().encode(fields[field] as string).length > 100_000) throw new BadRequest(`${field} must be bounded text`);
    config[field] = fields[field] as string;
  }
  if (config.systemPrompt !== undefined && (!config.systemPrompt.trim() || config.systemPrompt.length > 32000)) throw new BadRequest("systemPrompt must contain 1–32000 characters");
  if (config.systemPromptAppend !== undefined && config.systemPromptAppend.length > 32000) throw new BadRequest("systemPromptAppend must be at most 32000 characters; empty removes it");
  if (fields.definitionRevision !== undefined) config.definitionRevision = Number(fields.definitionRevision);
  if (Array.isArray(fields.definitionOverrides)) config.definitionOverrides = fields.definitionOverrides as string[];
  if (!config.model?.trim()) throw new BadRequest("model must be nonempty");
  for (const field of ["fileTools", "codeMode"] as const) {
    if (fields[field] !== undefined && typeof fields[field] !== "boolean") throw new BadRequest(`${field} must be a boolean`);
    if (fields[field] !== undefined) config[field] = fields[field] as boolean;
  }
  if (fields.decide !== undefined && fields.decide !== null) {
    if (typeof fields.decide !== "boolean") throw new BadRequest("decide must be true or false, or null for the default");
    config.decide = fields.decide;
  }
  if (config.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(config.thinkingLevel)) throw new BadRequest("Invalid thinkingLevel");
  if (fields.maxOutputTokens !== undefined) config.maxOutputTokens = maxOutputTokensInput(fields.maxOutputTokens);
  if (fields.temperature !== undefined) config.temperature = temperatureInput(fields.temperature);
  if (fields.dataCollection !== undefined) config.dataCollection = dataCollectionInput(fields.dataCollection);
  if (fields.modelHeaders !== undefined) config.modelHeaders = modelHeadersInput(fields.modelHeaders);
  if (fields.runLimits !== undefined) config.runLimits = runLimitsInput(fields.runLimits);
  if (fields.language !== undefined) { try { config.language = languageInput(fields.language); } catch (error) { throw new ApiError(400, (error as Error).message); } }
  if (fields.builtins !== undefined) {
    if (!Array.isArray(fields.builtins) || fields.builtins.length > BUILTINS.length || new Set(fields.builtins).size !== fields.builtins.length || fields.builtins.some(x => typeof x !== "string" || !BUILTINS.includes(x))) throw new BadRequest("Unsupported or repeated builtin");
    config.builtins = fields.builtins as string[];
  }
  if (fields.webSearch !== undefined) {
    const search = object(fields.webSearch, ["providers"]);
    try { config.webSearch = { providers: searchOrder(search.providers, "webSearch.providers") }; }
    catch(error) { throw new ApiError(400, (error as Error).message); }
  }
  if (fields.delegate !== undefined) {
    config.delegate = delegateInput(fields.delegate);
  }
  delegateSettings(config.builtins, config.delegate);
  if (fields.mcp !== undefined) {
    const mcp = object(fields.mcp, ["tools"]);
    if (!Array.isArray(mcp.tools) || mcp.tools.length > 10000) throw new BadRequest("mcp.tools must be an array");
    for (const tool of mcp.tools) if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || !tool.name) throw new BadRequest("An attached tool needs a name");
    config.mcp = { tools: mcp.tools as ToolDefinition[] };
  }
  for (const field of ["mcpServers", "openApi"] as const) if (fields[field] !== undefined) {
    if (!Array.isArray(fields[field]) || fields[field].length > 64) throw new BadRequest(`${field} must be an array of at most 64 sources`);
    config[field] = fields[field] as Record<string, unknown>[];
  }
  if (fields.humanInput !== undefined) config.humanInput = humanInputSettings(fields.humanInput);
  const workflow = workflowSettings(config.builtins, fields.workflow);
  if (workflow !== undefined) config.workflow = workflow;
  for (const field of ["subagents"] as const) if (fields[field] !== undefined) {
    if (!fields[field] || typeof fields[field] !== "object" || Array.isArray(fields[field])) throw new BadRequest(`${field} must be an object`);
    config[field] = fields[field] as Record<string, unknown>;
  }
  if (fields.spendLimit !== undefined) {
    const usd = spendInput(fields.spendLimit);
    config.spendLimit = usd === null ? null : { usd };
  }
  if (fields.initialMessages !== undefined && fields.importMessages !== undefined) throw new ApiError(400, "Give initialMessages or importMessages, not both", "INVALID_HISTORY");
  if (fields.initialMessages !== undefined || fields.importMessages !== undefined) {
    try {
      const messages = attachmentMessages(fields.importMessages !== undefined ? toPiMessages(fields.importMessages as never) : fields.initialMessages);
      validateInitialMessages(messages as never);
      config.initialMessages = messages as unknown[];
    } catch (error) { throw new ApiError((error as {status?: number}).status ?? 400, (error as Error).message, (error as Error).message.startsWith("HISTORY_TOO_LARGE") ? "HISTORY_TOO_LARGE" : "INVALID_HISTORY"); }
  }
  if (fields.mounts !== undefined) {
    if (!Array.isArray(fields.mounts) || fields.mounts.length > VOLUME_LIMITS.mounts) throw new BadRequest(`At most ${VOLUME_LIMITS.mounts} mounts`);
    config.mounts = fields.mounts.map(raw => {
      const mount = object(raw, ["volumeId", "path", "mode", "subpath", "workspace", "notify"]);
      if ("workspace" in mount) {
        if (typeof mount.workspace !== "boolean" || Object.keys(mount).some(key => key !== "workspace" && (mount.workspace !== true || key !== "path"))) throw new BadRequest("Invalid workspace mount");
      } else if (typeof mount.volumeId !== "string" || !["rw", "ro"].includes(String(mount.mode))) throw new BadRequest("Invalid mount");
      if (mount.notify !== undefined && typeof mount.notify !== "boolean") throw new BadRequest("notify must be a boolean");
      if (mount.path !== undefined && (typeof mount.path !== "string" || !mount.path.startsWith("/") || mount.path.split("/").some(x => x === ".." || x === "."))) throw new BadRequest("Invalid mount path");
      return mount;
    });
  }
  if(fields.remount!==undefined&&typeof fields.remount!=="boolean")throw new BadRequest("remount must be a boolean");
  const ttlSeconds = fields.ttlSeconds;
  if (ttlSeconds !== undefined && ttlSeconds !== null && (!Number.isInteger(ttlSeconds) || Number(ttlSeconds) < 60 || Number(ttlSeconds) > 366 * 86400)) throw new BadRequest("ttlSeconds must be 60 to 31622400 or null");
  const idleTtlSeconds = fields.idleTtlSeconds;
  if (idleTtlSeconds !== undefined && idleTtlSeconds !== null && (!Number.isInteger(idleTtlSeconds) || Number(idleTtlSeconds) < 60 || Number(idleTtlSeconds) > 366 * 86400)) throw new BadRequest("idleTtlSeconds must be 60 to 31622400 or null");
  if (ttlSeconds != null && idleTtlSeconds != null) throw new BadRequest("Give ttlSeconds or idleTtlSeconds, not both");
  if (idleTtlSeconds !== undefined) config.idleTtlSeconds = idleTtlSeconds as number | null;
  return { config, ttlSeconds: (ttlSeconds ?? idleTtlSeconds ?? ttlSeconds) as number | null | undefined };
}
