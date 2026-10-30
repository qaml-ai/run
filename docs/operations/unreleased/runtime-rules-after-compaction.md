### Agents keep the runtime's rules after a compaction

Since native compaction (#316), every agent lost the runtime's part of its system prompt (how to use tools, files and
results, and who sent a message: the `RUNTIME_CONTEXT` sender rules) at its first compaction, and every request after
it went without them; the application's instructions, the environment summary and the language stayed. The rules were
the system message's content, and Pi's baseline after a compaction writes sections only. They are now the system
message's first section, untagged: a new agent's prompt is the same text as before. An existing agent keeps its prompt
until its next compaction, which now keeps the rules; one that already lost them gets them back, in their place, on its
next request (one request re-declares its sections). No migration: stored contexts are read as they are.
