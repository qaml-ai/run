-- An agent's history in pages (src/history-pages.ts): its settled messages as immutable chunks in
-- Storage (`sessions/<agent>/history/<start>-<count>-<hash>`), each a run of whole turns unless one turn
-- alone is too large, indexed here so a page reads only the chunks it returns.
create table agent_history_chunks (
  agent text not null,
  -- The absolute index of the chunk's first message, and how many it holds.
  start integer not null,
  count integer not null,
  bytes integer not null,
  -- The start of the chunk's SHA-256: its key, so a blob a failed writer left is never read for another's row.
  hash text not null,
  -- Where turns begin among its messages (absolute indexes): where a page may start.
  turns integer[] not null,
  primary key (agent, start)
);
-- How many of an agent's messages the chunks cover (0 .. indexed - 1). Chunks are written in order,
-- each only where the last one ended, so they never overlap. No row: the agent predates the index.
create table agent_history_index (
  agent text primary key,
  indexed integer not null
);
