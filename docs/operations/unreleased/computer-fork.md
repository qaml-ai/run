### Fork a computer into sub-agents

`delegate` and `spawn_agent` (also from code) take `computer`: `"fresh"`, `"fork"` or
`"none"`. With `"fork"`, the child's computer starts as a copy of its parent's disk as it is at the call: repos,
installed packages and build caches, not running processes. Every child of one model response or script starts from
one snapshot, taken once. Each fork is its own machine, keyed by the child: its writes never reach its parent or a
sibling. A `delegate` child's computer session now stops when its call ends. API users fork with
`POST /v1/computers/{id}/fork` or `POST /v1/agents/{id}/computer/fork` and `{ "agents": [...] }` (at most 16, each
with no computer connection yet; all or none); forked connections show `forkedFrom`.

Boat forks (managed, or a tenant's own key) use Boat saved snapshots of the running machine, so they are exact; the
source keeps running. Boat snapshots only machines made with its background snapshots on, so connections have
`forkable`: managed ones default to true (their Boat machines are now made with snapshots on), a tenant's own key to
false (set `"forkable": true` in `POST /v1/computers` to fork it). On the Workers backend, Cloudflare container
computers fork with native container snapshots, and the native `computer` tool's computer forks too; its `restore`
with `from: "parent"` stand-in is gone. Providers that cannot copy a disk (Lambda MicroVMs, Sprites, E2B, Daytona,
Modal, tunnels, browsers), and connections that are not forkable, answer `409 FORK_UNSUPPORTED` and make nothing; a
computer with no running session answers `409 NO_SESSION`.

A snapshot is deleted when the last connection made from it is removed (after a 10-minute grace for siblings) and
when its account is deleted; the computer sweep retries failed deletes with backoff and gives up after 10 attempts.
Fork compute is billed as any computer session; managed Boat saved-snapshot storage is not charged separately.
Migration `115_computer_forks.sql` adds `computer_snapshots` and the connections' `seed`, `forked_from` and
`forkable`. `AGENT_BOAT_API_URL` overrides Boat's API base (tests).
