-- Agents busy with runs, across the fleet, so a tenant's busy-agent limit holds on every node together
-- (src/busy-agents.ts). A row counts only while the node session that wrote it has a live heartbeat.
create table busy_agents (
  agent text primary key,
  tenant text not null,
  node text not null,
  session uuid not null
);
create index busy_agents_tenant on busy_agents (tenant);
