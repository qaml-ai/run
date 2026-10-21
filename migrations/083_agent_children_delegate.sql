-- Delegate children (src/client-sessions.ts): a delegate call's child gets a row too ('delegate'), written before its
-- prompt is sent, so its parent's abort, stop and delete reach it through the database on any node, even after the
-- node that made it is lost. Its answer goes to the call, never as a notification: the row lands once, charging the
-- child's spend once, by the call that took the answer ('call'), the parent's stop that waited for the child ('stop'),
-- or a sweep that found the child ended after its parent's run had ('late').
alter table agent_children drop constraint agent_children_kind_check;
alter table agent_children add constraint agent_children_kind_check check (kind in ('spawn', 'message', 'resume', 'delegate'));
alter table agent_children drop constraint agent_children_landed_by_check;
alter table agent_children add constraint agent_children_landed_by_check check (landed_by in ('notice', 'wait', 'steer', 'superseded', 'call', 'stop', 'late'));
