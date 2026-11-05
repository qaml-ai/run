/** Browser clients may use a separate frontend, or omit it on a private runtime. */
export function browserUrl(env: { AGENT_BROWSER_URL?: string; AGENT_PUBLIC_URL?: string }, fallback: string) {
  return (env.AGENT_BROWSER_URL ?? env.AGENT_PUBLIC_URL ?? fallback).replace(/\/+$/, "");
}

/** Keep a missing provider key actionable without letting Pi read ambient credentials. */
export function missingModelKey(provider: string, id: string, env: { AGENT_TENANT?: string }) {
  const hint = env.AGENT_TENANT
    ? ' On this self-hosted runtime, AGENT_TENANT_API_KEYS in its environment sets keys too ({"anthropic": "sk-ant-..."}; restart it after).'
    : '';
  return `No ${provider} API key is configured for this agent's model, ${provider}/${id}; set one with PUT /v1/providers/${provider}/key, or move the agent to a model you can use (GET /v1/models?available=true)${hint}`;
}
