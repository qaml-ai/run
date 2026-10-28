### Pi from its main branch, vendored (cannot be rolled back)

**This deploy cannot be rolled back.** The first session a node on this release touches is stored in formats Pi 1.4.0
cannot read: `pi.live` version 3, and in-flight `pi.tool` version 3 and `pi.generation` version 2 tasks. A node on the
release before fails to open such a session (`Document … (pi.live) has newer version 3 than 1`); it writes nothing, and
the session works again once a node on this release loads it. So if this release misbehaves, roll forward with a fix:
a rollback (by hand, or ECS's circuit breaker or a deployment alarm) makes every agent that ran on it fail to load
until the next deploy. During the rolling deploy the same failure can hit an agent that ran on a new node, sat idle
for 5 minutes (unloaded), and was loaded next by an old node that has not started retiring yet; sessions from the
release before open on new nodes as usual.

The runtime now runs on Pi built from commit `02a2b2532d8f` of its main branch (2026-10-28) instead of the npm
release 1.4.0: `vendor/pi/` holds the six packages (`pi-durable`, `pi-ai`, `chord`, `pi-codemode`, `pi-telemetry`,
and `pi-agent-core` for types), `vendor/pi/PI_COMMIT` names the commit, and `scripts/vendor-pi.sh <sha>` bumps it
(`docs/operations/pi-vendoring.md`). Nothing of Pi comes from npm any more. The published SDKs never depended on Pi.

What changes with it:

- **Runs a lost node left are no longer parked.** A model request in flight when its node died is not sent again on
  open: with Pi's retry off, the run ends at once with "The host stopped while the model was answering" (Pi's
  `runFailure` reason `interrupted`). Work cut off `restartLimit` (5) times in a row ends instead of parking: a tool call
  with an error result (its outcome is shown as unknown, like an interrupted call's), a generation with the run failed
  (`restart_limit`). The runtime's own resume of a turn its node lost (`AGENT_MAX_RESUMES`) is unchanged. The adapter's
  handling of parked generations ("cut off by repeated node failures") is gone.
- **`pi_report` logs**: `report` is `storage_failed` (was `session_failed`), `task_interrupted` (new; with `reason`
  `interrupted` or `restart_limit`) or `task_outdated` with `reason` `task_too_old`; `task_parked` is gone. Each line
  now carries the report's `reason` where it has one.
- **A continue on a context that ends in an answer** asks no model: the run ends with "The conversation has nothing
  to answer" (Pi's `nothing_to_answer`). Continues the runtime makes itself (after a failed or taken-back response, a
  resumed tool round) end in a user message or tool results and are unaffected.
- **Streamed progress is stored as before**: Pi now defers storing partial answers and tool output by up to 1 s; the
  runtime sets `persistWithinMs: 0`, so each is stored right after its commit, as on 1.4.0.
- **Memory**: Pi no longer copies a growing answer or tool-call argument string on every partial commit, nor re-parses
  streamed tool-call arguments on every delta (a 500 KB tool call took about 20 s of CPU and a 100 MB heap peak).
- **Model catalog** (pi-ai's, generated when the commit was vendored): GPT-6.1 Terra is Pi's own entry on OpenAI,
  Azure and OpenRouter (same prices; it can now reason not at all, `thinkingLevel: "off"` sends effort `none`).
  OpenRouter DeepSeek V4.1 Flash's longest reply is 131,072 (was 393,216). Several OpenRouter list prices moved;
  OpenRouter calls are still billed what OpenRouter reports. Realtime and image models are no longer chat models
  (`openai/gpt-realtime-2.1`, `google/gemini-3.1-flash-live-preview`), and some old OpenRouter, OpenCode, Mistral and
  Radius ids are gone; existing agents keep the model they were created with. The prices and limits of the Anthropic,
  OpenAI, Google, Azure, Bedrock and DeepSeek models the runtime already listed are unchanged.

Rollout: deploy when someone can roll forward at once, and watch, at 15 minutes and 1 hour: agent loads that fail with
"has newer version" (expected only during the rollout, from old nodes), `pi_report` by `report` (`storage_failed` at
the old `session_failed` rate; `task_interrupted` where node losses were), turn outcomes and `model_error`, Postgres
commit latency and transactions per turn (flat, with `persistWithinMs: 0`), and `agent_memory` (lower peaks on long
answers and tool calls).
