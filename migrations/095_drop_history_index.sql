-- The history index (agent_history_index, agent_history_chunks): history is read from Pi storage by ordinal, and the
-- index's chunks were moved into it as archive entries (POST /v1/operations/history-archive, coverage gate ready).
-- Their Storage blobs (sessions/<id>/history/) go with each agent's purge.
drop table if exists agent_history_chunks;
drop table if exists agent_history_index;
