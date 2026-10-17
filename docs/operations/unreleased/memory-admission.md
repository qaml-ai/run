### A node short of memory starts no agents; work it cannot take goes to a peer

`AGENT_MEMORY_HIGH_BYTES` (unset by default; the hosted runtime sets about two thirds of its task's memory): above
it, a node starts no agent and takes no orphaned work, so inline agents cannot grow a node into its OOM kill. A run
the node refuses for its own limits (`AGENT_MAX_AGENTS`, or memory) is handed to a live peer instead of retrying where
there is no room. See [Persistence](persistence.md).
