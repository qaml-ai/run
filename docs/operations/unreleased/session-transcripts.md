### Read transcripts across an agent's conversation tree

`GET /v1/agents/{id}/sessions` returns bounded pages of retained messages from an
agent and its descendants in a time range. The TypeScript and Python runtime
clients expose `sessions`. Existing history endpoints are unchanged.
