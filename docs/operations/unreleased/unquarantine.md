### The by-hand agent quarantine is gone

`QUARANTINED_AGENTS` is removed: a full indexed history read past 64 MiB now answers 413 before reading (#428), and a
sweep load that takes its node down backs the agent off across nodes (#429), so one agent can no longer run node
after node out of heap.
