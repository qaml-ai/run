-- A tenant's GitHub Apps (src/core/github-apps.ts): the App ID, the private key and webhook secret sealed with
-- AGENT_SECRETS_KEY (under `github-app:<id>`), the rest of the record as JSON. The runtime mints installation tokens
-- from them for computer egress grants and tool sources whose auth is { type: "github-app" }.
create table if not exists github_apps (
  id text primary key,
  tenant text not null,
  name text not null,
  app jsonb not null,
  created_at bigint not null,
  unique (tenant, name)
);
