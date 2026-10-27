### One history read is capped, and a node near its heap limit names its busy agents

A read of an agent's history messages from its journal (`JournalHistory.messagesFrom`: a turn's messages on resume,
the history index's tail on a page read) fails past 64 MiB of message JSON, rather than taking it all into memory.
On 2026-10-27 from 13:00Z such reads took nodes to their 2 GB heap limit about once a minute, and the orphan sweep
carried the work to the next node. `agents_resumed` now lists the agents a sweep loaded, and `node_load` lists
`busyAgents` (those with work running) while the heap is past 1 GiB.
