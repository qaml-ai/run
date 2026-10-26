### Retire nodes under sustained memory pressure

`AGENT_MEMORY_RETIRE_MS` enables memory retirement after sustained pressure, plus up to 10 minutes of per-node jitter. It defaults to 0 (disabled); ECS sets 10 minutes. A claim requires a live, non-draining peer below its memory threshold, with one retirement at a time and at least 10 minutes between claims. Nodes publish their memory pressure with their heartbeat.

A retiring node stops taking agents, hands turns to peers, and calls ECS StopTask on its own task. `/healthz` stays 200 while ECS deregisters and replaces it; the first SIGTERM joins the drain without cutting turns. Without an external signal, `AGENT_MEMORY_RETIRE_FALLBACK_MS` (default 10 minutes after claiming) finishes the drain and exits 0, or 1 if the drain fails. Handed-off turns record `memory` in `handoffs[].reason`.

The task role needs `ecs:StopTask`; apply `infra/terraform/ecs.tf` to enable this path. If StopTask is unavailable or fails, the node uses `/healthz` 503 only when its deployment is current. Otherwise it releases the memory claim without undraining and retries after backoff. Logs identify the StopTask, health-check, or deferred path.
