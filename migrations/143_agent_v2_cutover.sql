create table agent_v2_cutovers (
  tenant text not null,
  agent text not null,
  operation uuid not null,
  primary key (tenant, agent)
);

-- Existing v1 tasks already insert under the tenant's busy-agent lock. Enforce the fence
-- at that write so installing it does not require restarting any runtime tasks.
create function reject_fenced_v1_run() returns trigger language plpgsql as $$
begin
  if exists (select from agent_v2_cutovers where tenant = new.tenant and agent = new.agent) then
    raise exception 'AGENT_V2_CUTOVER: New v1 runs are disabled for this agent during its v2 cutover' using errcode = 'CV201';
  end if;
  return new;
end;
$$;
create trigger reject_fenced_v1_run before insert on busy_agents
  for each row execute function reject_fenced_v1_run();
