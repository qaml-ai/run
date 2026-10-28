### The history index is gone

Every agent's history is now read from its Pi storage alone: the history index's tables (`agent_history_index`,
`agent_history_chunks`) are dropped (migration 095) after their messages moved into Pi storage as archive entries, and the
move's endpoint (`/v1/operations/history-archive`), the chunk fallback, the legacy coverage's `retired_index_short` count
and the pin backfill's history pages go with them. Journal reclaim's stage 2 now selects every retired host transcript.
Leftover chunk blobs are removed with each agent's purge.
