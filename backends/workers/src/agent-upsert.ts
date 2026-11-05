import { configuration, ApiError } from "./api-contract.ts";
import { Directory, type ControlEnv } from "./control.ts";

/** Existing keyed agents are configured through the same request path as PATCH. */
export async function upsertAgent(env: ControlEnv, tenant: string, input: Record<string, unknown>, key: string | undefined, origin: string) {
  const directory = new Directory(env, tenant);
  const existing = key === undefined ? null : await directory.get(key);
  // Definitions carry trusted, already-provisioned tool configuration. Keep
  // that path in the directory instead of treating it as a caller's PATCH.
  if (!existing || input.definition !== undefined) return { entry: await directory.upsert(input, key, origin) };
  // The default model only applies at creation. Language is deliberately absent
  // from old SDKs' upserts, so only an explicit value (including null) changes it.
  const params: Record<string, unknown> = { ...configuration(input, existing.config.model ?? env.MODEL).config };
  if (input.remount !== undefined) params.remount = input.remount;
  const defaults = { codeMode: true, fileTools: true, thinkingLevel: "off", systemPromptAppend: "", maxOutputTokens: null, temperature: null, dataCollection: null, runLimits: null, modelHeaders: null };
  for (const [field, value] of Object.entries(defaults)) {
    if (input[field] === undefined && existing.config[field as keyof typeof existing.config] !== undefined) params[field] = value;
  }
  if (input.model === undefined) delete params.model;
  if (input.language === undefined) delete params.language;
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
