The decision inbox is available at `GET /v1/inbox` on both backends, with filters,
keyset pagination and counts by priority and lead. It reads `agent_inputs`;
Workers no longer calls each agent to list tenant inputs. `GET /v1/inputs` keeps
its array response and state filter, and uses the same index and queue order.
