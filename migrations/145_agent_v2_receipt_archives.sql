create table agent_v2_receipt_archives (
  tenant text not null,
  agent text not null references agents (id) on delete cascade,
  receipts jsonb not null check (jsonb_typeof(receipts) = 'array'),
  primary key (tenant, agent),
  foreign key (tenant, agent) references agent_v2_routes (tenant, agent) on delete cascade
);

create function purge_v1_receipt_archive() returns trigger language plpgsql as $$
begin
  delete from agent_v2_receipt_archives where tenant = old.tenant and agent = old.id;
  return new;
end;
$$;
create trigger purge_v1_receipt_archive after update of purged_at on agents
  for each row when (old.purged_at is null and new.purged_at is not null)
  execute function purge_v1_receipt_archive();
