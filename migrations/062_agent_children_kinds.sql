-- Background sub-agents, continued (src/client-sessions.ts). A row is now one run of a child its parent waits to hear
-- from: the run spawn_agent started ('spawn'), one a parent's send_message started on its child ('message'), or the
-- turn a child resumes once a person answered what it asked ('resume'). `made`: the runtime made the child (not a
-- named agent), so deleting the parent deletes it. A run folded into another (a message its running turn took, or a
-- resume a new message superseded) lands nothing: `landed_by` 'steer' or 'superseded'. Names are the parent's handles
-- for its spawned children, so only spawn rows keep them unique.
alter table agent_children add column kind text not null default 'spawn' check (kind in ('spawn', 'message', 'resume'));
alter table agent_children add column made boolean not null default true;
alter table agent_children drop constraint agent_children_landed_by_check;
alter table agent_children add constraint agent_children_landed_by_check check (landed_by in ('notice', 'wait', 'steer', 'superseded'));
drop index agent_children_running_name;
create unique index agent_children_running_name on agent_children (parent, name) where state = 'running' and kind = 'spawn';
create index agent_children_child on agent_children (child, created_at);
