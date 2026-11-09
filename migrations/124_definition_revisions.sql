-- Retain definition revisions so a delegate can pin its configuration.
create table definition_revisions (like definitions including defaults);
alter table definition_revisions add primary key (id, revision);
insert into definition_revisions select * from definitions;
create function retain_definition_revision() returns trigger language plpgsql as $$
begin
  insert into definition_revisions select new.* on conflict (id, revision) do nothing;
  return new;
end;
$$;
create trigger retain_definition_revision after insert or update on definitions
for each row execute function retain_definition_revision();
-- Deleting a definition also deletes its historical configurations and secrets.
alter table definition_revisions add foreign key (id) references definitions(id) on delete cascade;
