# Session transcripts

`GET /v1/agents/{id}/sessions` reads an agent's conversation and its descendants'
conversations. Use a tenant API key. Browser tokens and agent tokens cannot read
this endpoint.

Pass `from` and `to` as epoch milliseconds. The response includes messages with
`from <= timestamp < to`. `children=false` reads only the named agent; the default
includes descendants recorded by delegate and background-agent calls. Optional
`endUser` selects messages belonging to that end user, including the assistant
and tool messages within their retained request. Messages without a retained
request identity are excluded when a filter is set.

```ts
let cursor: string | undefined;
do {
  const page = await runtime.sessions(agentId, {
    from: Date.parse("2026-11-01T00:00:00Z"),
    to: Date.parse("2026-11-02T00:00:00Z"),
    cursor,
    limit: 100,
  });
  for (const entry of page.entries) {
    console.log(page.agentId, entry.index, entry.message);
  }
  cursor = page.next ?? undefined;
} while (cursor);
```

Python has `runtime.sessions(agent_id, from_ms=..., to_ms=..., cursor=...)` in
both clients. Await it with the asynchronous client.

Each page reads one conversation, ordered by agent ID and then message index.
`limit` is 1–500 messages before filtering, default 100. Empty pages can have a
`next` cursor: follow it until null. Treat cursors as opaque and reuse the same
agent, time range, `children`, and `endUser` settings. A page reads about 1 MB at most,
except that one oversized message is returned whole. Pages preserve message
indexes and the stored transcript format, including tool calls and results.

This is a live view of retained history, not a snapshot or a run-status listing.
Deleted or expired agents and purged messages are unavailable. Messages without timestamps
are excluded. Choose a closed time window after runs settle when consolidating
memory. Keep transcripts private: they can contain user content and tool output.
