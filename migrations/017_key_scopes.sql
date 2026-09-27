-- Key scopes (src/key-scopes.ts): named sets of provider credentials within a tenant, e.g. one per
-- customer org of an application, that its agents call models with.
create table key_scope_providers (
  tenant text not null,
  scope text not null,
  provider text not null,
  -- AES-256-GCM under AGENT_SECRETS_KEY, bound to "key-scope:<tenant>:<scope>:<provider>": {apiKey, headers?}.
  sealed jsonb not null,
  last4 text not null,
  -- What is not secret: {baseUrl?, region?, headers? (names only)}.
  settings jsonb not null default '{}',
  set_at bigint not null,
  primary key (tenant, scope, provider)
);
