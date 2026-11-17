### Idle compaction on Node

Node-hosted agents now compact eligible conversations in the background while idle, using the same model and cached prompt prefix. This also applies to existing agents after their next eligible model response. Foreground input cancels the background summary.

Idle compaction is enabled by default. Set `idleCompaction: false` per agent through create, upsert or configuration PATCH. The SDKs expose `idleCompaction` in TypeScript and `idle_compaction` in Python. An omitted upsert field keeps the agent's setting. Operators can set `AGENT_IDLE_COMPACTION=0` to disable it deployment-wide. Summary tokens follow the existing compaction billing path.
