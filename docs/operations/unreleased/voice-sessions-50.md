### 50 live voice sessions per account, spread across nodes

- `AGENT_VOICE_SESSIONS_PER_TENANT` now defaults to 50 (was 10), measured against what a node holds; see
  [the pipeline](voice-pipeline.md#sessions-per-node). A tenant's `maxVoiceSessions` still comes first.
- `AGENT_VOICE_SESSIONS_PER_NODE` now defaults to 15 (was 200), and is no longer a hard stop: a node at its share leaves
  a session to its peers, and any node takes one no peer has taken within 30 seconds. **Self-hosters:** on a single node,
  a session past 15 connects about 30 seconds later, unless you set this for your machine.
- A node past `AGENT_MEMORY_HIGH_BYTES` takes no voice sessions until it falls.
