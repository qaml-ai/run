### One agent is quarantined by hand

`QUARANTINED_AGENTS` (src/client-sessions.ts) names agents no node loads: their requests answer 503 and sweeps put
them off. It holds the `miguel` tenant's agent whose work ran every node that loaded it out of heap on 2026-10-27.
