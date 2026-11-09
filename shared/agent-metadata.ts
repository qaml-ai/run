export interface AgentMetadata { name?: string; type?: string; application?: Record<string, unknown> }
export function agentMetadata(input: AgentMetadata): AgentMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Agent metadata must be an object");
  const result: AgentMetadata = {};
  for (const key of ['name', 'type'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.length > 120) throw new Error(`${key} must contain 1–120 characters`);
    result[key] = value.trim();
  }
  if (input.application !== undefined) result.application = applicationMetadata(input.application);
  return result;
}

/** Tenant-owned application data; never interpreted as model instructions. */
export function applicationMetadata(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("metadata must be a JSON object");
  const text = JSON.stringify(input);
  if (new TextEncoder().encode(text).length > 16_384) throw new Error("metadata must be at most 16384 bytes of JSON");
  return JSON.parse(text);
}

export function metadataFilters(query: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of query) if (key.startsWith("metadata.")) {
    const field = key.slice(9);
    if (!field || field.length > 120 || Object.hasOwn(result, field)) throw new Error("metadata filters need unique keys of 1–120 characters");
    result[field] = value;
  }
  applicationMetadata(result);
  return result;
}
