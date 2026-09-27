-- An agent's event cursor where its last owner stopped (src/client-sessions.ts): `cursor_clean` says
-- no event was published after `last_cursor`, so the next owner goes on from it and a subscriber
-- holding it resumes without a gap. A load clears it at once, so a crash never reuses an id.
alter table agents add column last_cursor bigint;
alter table agents add column cursor_clean boolean not null default false;
