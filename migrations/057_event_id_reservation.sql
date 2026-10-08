-- The highest event id any owner of the agent has reserved (src/client-sessions.ts `reserveEvents`). An owner reserves
-- a block of ids, under its claim, before it publishes any of them, and a load that is not clean starts above every id
-- reserved, so a successor never reuses an id its predecessor published, whatever the nodes' clocks say. Rows from
-- before carry their stored cursor: what an owner then published past it was recorded nowhere.
alter table agents add column reserved_cursor bigint;
update agents set reserved_cursor = last_cursor where last_cursor is not null;
