-- The busy-agent tenant lock still enforces the v1 quota. This lock serializes
-- admission and migration only for the same source agent.
create function try_v1_agent_admission_lock(tenant text, agent text)
returns boolean language sql volatile as $$
  select pg_try_advisory_xact_lock(
    hashtextextended(jsonb_build_array('v1-agent-admission', tenant, agent)::text, 0)
  )
$$;

create or replace function reject_fenced_v1_run() returns trigger language plpgsql as $$
begin
  if not try_v1_agent_admission_lock(new.tenant, new.agent) then
    raise exception 'AGENT_V2_CUTOVER: Agent admission is changing; retry'
      using errcode = 'CV201';
  end if;
  if exists (select from agent_v2_cutovers where tenant = new.tenant and agent = new.agent) then
    raise exception 'AGENT_V2_CUTOVER: New v1 runs are disabled for this agent during its v2 cutover'
      using errcode = 'CV201';
  end if;
  return new;
end;
$$;
