import type { AgentConfiguration } from './api-contract.ts';

/** Reset omitted settings against the configuration immediately before this upsert. */
export function replacementConfiguration(current: AgentConfiguration, input: Record<string, unknown>) {
  const params = { ...input };
  if (input.metadata === undefined && current.metadata !== undefined) params.metadata = current.metadata;
  if (input.definition !== undefined) return params;
  const defaults = {
    codeMode: true, fileTools: true, thinkingLevel: 'off', systemPromptAppend: '',
    maxOutputTokens: null, temperature: null, dataCollection: null, runLimits: null, computerLimit: null, modelHeaders: null,
  };
  for (const [field, value] of Object.entries(defaults))
    if (input[field] === undefined && current[field as keyof AgentConfiguration] !== undefined) params[field] = value;
  return params;
}
