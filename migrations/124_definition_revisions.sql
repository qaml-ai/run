-- Retain definition revisions so a delegate can pin its configuration.
create table definition_revisions (like definitions including defaults);
alter table definition_revisions add primary key (id, revision);
insert into definition_revisions (id, tenant, name, revision, spec, created_at, updated_at)
select id, tenant, name, revision, spec, created_at, updated_at from definitions;

-- A rotated or removed credential must not remain usable through a pinned revision.
-- Keep historical configuration, but discard ciphertext unless the live source
-- still has the same name, URL and sealed value.
create function prune_definition_revision_secrets(previous json, current_spec json) returns json
language plpgsql immutable as $$
declare
  result jsonb := previous::jsonb;
  kind text;
begin
  foreach kind in array array['mcpServers', 'openApi'] loop
    if jsonb_typeof(result->kind) = 'array' then
      result := jsonb_set(result, array[kind], coalesce((
        select jsonb_agg(case when source ? 'sealed' and not exists (
          select 1 from jsonb_array_elements(case when jsonb_typeof(current_spec::jsonb->kind) = 'array' then current_spec::jsonb->kind else '[]'::jsonb end) live
          where live->>'name' = source->>'name' and coalesce(live->>'url', live->>'baseUrl') = coalesce(source->>'url', source->>'baseUrl')
            and live->'sealed' = source->'sealed'
        ) then source - 'sealed' else source end)
        from jsonb_array_elements(result->kind) source
      ), '[]'::jsonb));
    end if;
  end loop;
  return result::json;
end;
$$;

create function retain_definition_revision() returns trigger language plpgsql as $$
begin
  update definition_revisions set spec = prune_definition_revision_secrets(spec, new.spec)
    where id = new.id;
  insert into definition_revisions (id, tenant, name, revision, spec, created_at, updated_at)
    values (new.id, new.tenant, new.name, new.revision, new.spec, new.created_at, new.updated_at)
    on conflict (id, revision) do nothing;
  return new;
end;
$$;
create trigger retain_definition_revision after insert or update on definitions
for each row execute function retain_definition_revision();
-- Deleting a definition also deletes its historical configurations and secrets.
alter table definition_revisions add foreign key (id) references definitions(id) on delete cascade;
