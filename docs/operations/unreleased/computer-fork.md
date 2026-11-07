### Fork a computer into sub-agents

`delegate` and `spawn_agent` (also from code) take `computer`: `"fresh"` (the default, as before), `"fork"` or
`"none"`. With `"fork"`, the child's computer starts as a copy of its parent's disk as it is at the call: repos,
installed packages and build caches, not running processes. Every child of one model response or script starts from
one snapshot, taken once. Each fork is its own machine, keyed by the child: its writes never reach its parent or a
sibling. A `delegate` child's computer session now stops when its call answers. API users fork with
`POST /v1/computers/{id}/fork` or `POST /v1/agents/{id}/computer/fork` and `{ "agents": [...] }` (at most 16, each
with no computer connection yet); forked connections show `forkedFrom`.

Boat forks (managed, or a tenant's own key) use Boat saved snapshots of the running machine, so they are exact; the
source keeps running. On the Workers backend, Cloudflare container computers fork with native container snapshots,
and the native `computer` tool's computer forks too; its `restore` with `from: "parent"` stand-in is gone. Providers
that cannot copy a disk (Lambda MicroVMs, Sprites, E2B, Daytona, Modal, tunnels, browsers) answer `409
FORK_UNSUPPORTED` and make nothing; a computer with no running session answers `409 NO_SESSION`. A snapshot is
deleted when the last connection made from it is removed; the computer sweep retries failed deletes. Fork compute is
billed as any computer session. Migration `113_computer_forks.sql` adds `computer_snapshots` and the connections'
`seed` and `forked_from`. `AGENT_BOAT_API_URL` overrides Boat's API base (tests).
