### `history: "none"` is ignored: every run sees the agent's history

Prompts (REST, the SDKs' `run`, `stream`, `send` and `client.prompt`) and schedules (REST, the SDKs' `schedule`, the
`schedule` built-in, the MCP server's `add_schedule`) still accept `history: "none"` and `"full"`, so existing callers
and stored schedules do not fail, but ignore it: every run, and every wake-up, sees the agent's history, which Pi's
compaction keeps bounded. For a run that sees no history, use a stateless run (`docs/guides/stateless-runs.md`)
(`POST /v1/runs`, `agents.run({ instructions, input })`). The field is marked deprecated in the OpenAPI schema and the
SDKs; `camelrun schedules add --history` prints a deprecation warning. The runtime logs `history_none_ignored`
(`agent`, `tenant`, `source`: `prompt` or `schedule`) once per agent and source per process, to find remaining callers.

The `schedule` built-in still accepts `history`, described to the model as ignored, so a model that sends it does not
fail; schedules no longer report it. A request that loses every user message no longer fails with code `context_lost`
(that guard served only history-none runs).
