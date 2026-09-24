-- Agent definitions: reusable, tenant-level agent configurations. `spec` is the
-- definition as the tenant wrote it, with any secrets sealed in place. Agents made
-- from one keep a copy of the revision they came from in their header.
create table definitions (
  id text primary key,
  tenant text not null,
  name text not null,
  revision bigint not null,
  spec json not null,
  created_at bigint not null,
  updated_at bigint not null
);
create index definitions_tenant on definitions (tenant);

-- Channels reference a definition instead of embedding a template: each existing
-- channel's template becomes a definition of its own. The template stays in the
-- channel document for nodes still running the previous release during the deploy.
insert into definitions (id, tenant, name, revision, spec, created_at, updated_at)
select 'def_' || substr(md5('channel:' || id), 1, 20), tenant, left(channel->>'name', 120), 1,
  (coalesce(channel::jsonb->'template', '{}'::jsonb) || jsonb_build_object('channel', id))::json,
  created_at, (extract(epoch from now()) * 1000)::bigint
from channels where channel->>'definition' is null;
update channels set channel = (channel::jsonb || jsonb_build_object('definition', 'def_' || substr(md5('channel:' || id), 1, 20)))::json
where channel->>'definition' is null;
