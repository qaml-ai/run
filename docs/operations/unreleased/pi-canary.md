### Operator-scoped Pi canary

`AGENT_PI_CANARY_AGENTS` and `AGENT_PI_CANARY_TENANTS` select exact agent or tenant
IDs for Pi while the default engine remains legacy. Apply identical lists on
every node so a canary remains on Pi after a handoff. Removing an ID returns its
next host to the default engine through the existing rollback path.

For the memory investigation, use 1 vCPU / 4096 MiB tasks with the existing
`AGENT_MEMORY_HIGH_BYTES=1395654656` admission threshold. Keep the tenant allowlist
empty; add only selected agents. Set `AGENT_LOAD_INTERVAL_MS=5000` to log Node
heap, RSS, voice workers, and visible cgroup current/high-water memory every five
seconds. The default remains 60 seconds and outbox polling stays at 60 seconds.
The cgroup may include helper processes; do not interpret it as just the Node heap.

Keep the existing protected ECS rollout for the initial instrumentation deploy:
the current retirement code waits for a full replacement fleet, so a one-task
surge limit can stall and eventually retire several old nodes together. Stage
Pi eligibility one agent at a time instead. Wait for the exact revision to reach
`COMPLETED`, including graceful retirement, before adding another agent. Observe
at least 30 minutes of actual activity per stage, including voice where relevant.
Stop expansion on request failures or sustained memory growth; roll back the
agent allowlist before memory reaches 3 GiB. Retain the larger tasks during an
engine rollback. These investigation settings are temporary ECS overrides,
not changes to Terraform's default task size.
