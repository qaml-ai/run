-- A tenant's own model providers (src/model-providers.ts): a server that speaks OpenAI Chat Completions,
-- named by the tenant, with the models it declares. Agents name its models `<name>/<model id>`.
create table model_providers (
  tenant text not null,
  name text not null,
  -- What is not secret: {type, baseUrl, models, headers? (names only)}.
  config jsonb not null,
  -- AES-256-GCM under AGENT_SECRETS_KEY, bound to "model-provider:<tenant>:<name>": {apiKey?, headers?}.
  sealed jsonb not null,
  last4 text not null,
  set_at bigint not null,
  primary key (tenant, name)
);
