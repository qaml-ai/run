-- Each history entry's place in its agent's history (src/pi-durable/ordinals.ts): its messages are history messages
-- msg_from .. msg_from + msg_count - 1, the entry's own history messages from its msg_skip-th on. A turn marker that
-- opens a turn has turn_start, at msg_from. Null for an entry with no history messages, or not placed (yet).
-- pi_durable_metadata.history_next is the history's length (the next message's place), and history_last_id the newest
-- session entry committed with it: null until an agent's ordinals are filled (POST /v1/operations/history-ordinals).
alter table pi_durable_entries add column msg_from integer, add column msg_count integer, add column msg_skip integer not null default 0, add column turn_start boolean not null default false;
alter table pi_durable_metadata add column history_next integer, add column history_last_id bigint;
