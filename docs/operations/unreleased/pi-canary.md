### Operator-scoped Pi canary

`AGENT_PI_CANARY_AGENTS` and `AGENT_PI_CANARY_TENANTS` select exact agent or tenant
IDs for Pi while the default engine remains legacy. Apply identical lists on
every node so a canary remains on Pi after a handoff. Removing an ID returns its
next host to the default engine through the existing rollback path.
