-- A child task keeps its run payer and bucket for later notifications. Tool identity stays on the agent.
alter table agent_children add column payer text;
alter table agent_children add column bucket text;
