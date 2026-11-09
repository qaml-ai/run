
# Application metadata

Set `metadata` to a JSON object on `POST /v1/agents`, or replace it with
`PATCH /v1/agents/{id}/configuration`. It is tenant-owned application data,
not model instructions. It is limited to 16,384 bytes of serialized UTF-8 JSON.
Omitting it preserves the current value (including on keyed upserts);
`{}` clears it. Top-level `name` and `type` retain their existing meanings.

Agent list and detail responses return `metadata` (an empty object for older
agents). Both backends also return `lastActiveAt` and `lastError` in lists.
Use `GET /v1/agents?metadata.type=camelcode-project` for exact, case-sensitive
matches on top-level string fields. Multiple metadata filters are ANDed;
numbers, arrays and nested objects are not string matches. Filtering happens
before pagination and is indexed. Existing list calls still return an array.

TypeScript: `agents.createAgent({ metadata: { type: "camelcode-project" } })`,
`agents.listAgents({ metadata: { type: "camelcode-project" } })`, and
`agents.setAgentMetadata(id, { repos: ["acme/app"] })`. Updates return a
configuration request; poll it for completion.

Python's `AgentRuntime.create_agent` and `Agents.upsert` accept `metadata`;
`runtime.list_agents(metadata={"type": "camelcode-project"})` filters it and
`runtime.set_agent_metadata(id, {...})` replaces it. The CLI accepts
`--metadata '{"type":"camelcode-project"}'` with `agents create`,
`agents configure`, and `agents list`.
