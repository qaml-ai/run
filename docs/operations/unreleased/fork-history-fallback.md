### Fork messages before a compaction or import cut

Forking an early message now succeeds when it predates the source's retained model context. The fork copies
the raw history through the requested point from the history index and journal, without the source's compaction
summary. This also works after obsolete context checkpoints have been reclaimed. Later fork points still use
Pi's retained context. Running turns and unknown messages keep their existing refusals.

The raw context is seeded whole. Normal compaction summarizes an oversized context on the fork's first turn,
in chunks when needed. If old usage counts understate its size, the normal provider-overflow path compacts
and retries. History remains complete. `fork_from_history` logs the source agent, cut index and message count,
without message content.
