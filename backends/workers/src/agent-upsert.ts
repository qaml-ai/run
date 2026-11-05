import { configuration, ApiError } from "./api-contract.ts";
import { Directory, type ControlEnv, type DirectoryEntry } from "./control.ts";

/** Existing keyed agents are configured through the same request path as PATCH. */
export async function upsertAgent(env: ControlEnv, tenant: string, input: Record<string, unknown>, key: string | undefined, origin: string) {
  const directory = new Directory(env, tenant);
  const existing = key === undefined ? null : await directory.get(key);
  if (!existing) return { entry: await directory.upsert(input, key, origin) };
  // The default model only applies at creation. Language is deliberately absent
  // from old SDKs' upserts, so only an explicit value (including null) changes it.
  const params: Record<string, unknown> = { ...configuration(input, existing.config.model ?? env.MODEL).config };
  const defaults = { codeMode: true, fileTools: true, thinkingLevel: "off", systemPromptAppend: "", maxOutputTokens: null, temperature: null, dataCollection: null, runLimits: null, modelHeaders: null };
  for (const [field, value] of Object.entries(defaults)) {
    if (input[field] === undefined && existing.config[field as keyof typeof existing.config] !== undefined) params[field] = value;
  }
  if (input.model === undefined) delete params.model;
  if (input.language === undefined) delete params.language;
  if (input.definition !== undefined) {
    for (const field of ["builtins", "delegate", "workflow", "decide", "mcpServers", "openApi"]) delete params[field];
  }
  const response = await env.AGENTS.getByName(existing.id).fetch(new Request("https://agent/requests", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: `upsert-${crypto.randomUUID()}`, method: "configure", params }),
  }));
  const reconfigured = await response.json() as { error?: string; code?: string };
  if (!response.ok) throw new ApiError(response.status, reconfigured.error ?? "Agent configuration was refused", reconfigured.code);
  const entry = await directory.get(existing.id);
  if (!entry) throw new ApiError(404, "Unknown agent", "AGENT_NOT_FOUND");
  return { entry, reconfigured };
}
