# Agents parity experiment

This is the agents track for `codex/workers-parity`. It is experimental and is
not a production rollout. The branch includes the money and platform tracks and
the backend-neutral contract suite. It does **not** reach full parity.

## Delivery boundary

The latest complete contract run is **223 pass / 367 fail**, with 380 out of
scope, at `d3b9d03b` on `rt-pool-3`. Node passed all 590 in-scope cases. Per the
wrap-up instruction, no replacement full run was started. The later focused
results below are distinct observations, not a new aggregate score.

[AGENTS-FAILURES.md](AGENTS-FAILURES.md) lists each remaining observed failure,
its exact test name, a one-line diagnosis and the source implementation to use
for the parallel gap-closing runs. The sanitized machine-readable evidence is
[agents-contract-handoff.json](https://github.com/qaml-ai/run/blob/962e764c37f25477aedea47b21ed09fc6242f914/backends/workers/measurements/agents-contract-handoff.json)
(archived; raw dumps are not kept in the tree).

The local branch `wip/agents-unfinished` retains the unverified configuration
queue, public list/activity/idempotency additions, reasoning retry and web-fetch
edits. Those changes are not part of the delivered tree and that branch is not
pushed. The retained first-prompt handling, provider repricing, default values
and paid-account lock each have passing focused evidence.

## What is retained

- Definitions, stateless runs, model options, structured output, virtual models,
  custom providers, OpenRouter and bearer-only Bedrock routing. These surfaces
  still have the contract gaps listed in the handoff.
- Attached SDK/client tools, MCP/OpenAPI source configuration, credential
  exchange, runtime identity and hosted MCP. Hosted MCP is partial (3/6 cases).
- Durable human input, decision calls, child ownership and delegation policy.
  Decisions pass 5/5 and human inputs 20/20. Delegation still has ordering,
  cancellation, wake-limit and child-spend gaps.
- Import, export, fork, compaction and bounded history paging. `AgentHistory`
  incrementally indexes 128 entries at a time, then pages by count and bytes.
  An unpaged response has a 64 MiB safety bound. Pi still materializes its active
  model context. Large fork imports retain a separate 32 KiB request-body gap.
- UI AI SDK message assembly and the source live-stream protocol. All five
  original UI tests pass; the newer streaming/messages selection passes 12/12.
- Source-generated run failures, prompts, model/output schemas, delegation,
  decisions, human-input, attachment, reset and spending policy. Drift scripts
  check these copies; portable source modules are imported directly.

Code mode uses Pi's stock `RemoteCodemodeSandbox`, tool replay and human-input
pause/resume. Each session selects one sandbox object, with a 24 MiB VM limit
and at most three concurrent scripts. The file tools expose the source `fs`
shim. Workflows are scripts that call `tools.delegate` (the workflow builtin is
gone, as on main). A call from code that needs a person ends the run
`input_required` as a direct call does; while the script waits only on people
its VM stops, and the answer's result starts a new VM that replays the script
(`codemode/sandbox.ts`). Waits on people and sub-agents are off the script's
clock. Host SDK `execute` has a separate
Pi conversation and does not add model history. Pi uses QuickJS here, so V8/Intl
semantics and exact v8-exec error names remain different. Its wall-time and
interrupt limits do not establish equivalent OS-enforced CPU accounting.

The image path remains unchanged. The per-request provider fetch is the seam
for the separate image-streaming work.

## Completed focused results

| Selection | Revision | Node | Workers |
| --- | --- | ---: | ---: |
| Agents, SDK, messages, streaming | `4241d8af` | 84/84 | 60/84 |
| Streaming and messages, later correction | `cbcbd28d` | 12/12 | 12/12 |
| Human input | `626eca88` | 20/20 | 20/20 |
| Delegation and decisions | `28528f8f` | 44/44 | 30/44 |
| Runs and history | `4241d8af` | 53/53 | 49/53 |
| Tools, MCP and sources | `d161edd4` | 42/42 | 28/42 |
| Models, providers and definitions | `7f79aee3` | 68/68 | 35/68 |
| Later configuration/custom-provider selection | `c1a32b21` | — | 21/26 |

The final selection includes all five custom-provider cases passing. These
selections overlap. Do not add their pass counts or treat them as a single run.

The earlier unchanged-assertion compatibility inventory reached **116 pass /
5 fail / 41 not applicable**, versus 64/56/42 for the same 162-case inventory:
**52 additional passes, 51 fewer failures**. Of the 116 passes, 71 exercised
workerd and 45 were SDK-only. Python reached 57 pass, 2 fail, 1 voice exclusion.
The remaining legacy failures concern PDF metadata, two lazy-connection counter
assertions, end-user credit and key-scope/webhook behavior. That inventory is
separate from the newer 590-case contract suite. Its raw TAP logs are not kept;
`measurements/compatibility.json` holds the latest recorded results.

## Delivery validation and cloud evidence

Quick delivery checks run on Sprites only: TypeScript, all Workers unit tests,
both Wrangler dry-run builds, source drift checks, docs/`llms.txt` and OpenAPI
generation. Exact revisions and final results are in
[agents-validation.json](measurements/agents-validation.json). No new full
contract run or full integration run is part of wrap-up. Earlier integration
coverage was 80/81; the remaining native-container test hit the Sprite kernel's
missing `xt_socket` support. (Since 2026-11-06 that test runs and passes on
Sprites; see [README.md, "Docker on a sprite"](README.md#docker-on-a-sprite).)

Two temporary deployed probes checked the sandbox memory/concurrency bounds,
cancellation and attached-tool reconnection after a 35-second idle eviction.
The latter retained one WebSocket and one MCP initialization. The Workers and
namespaces were deleted; no cloud resources are retained. Combined marginal
Cloudflare spend is estimated below $0.02; the invoice is not settled. Probe
requests and cleanup are recorded in
[agents-codemode-cloud.json](measurements/agents-codemode-cloud.json) and
[agents-ws-cloud.json](measurements/agents-ws-cloud.json). Sprites validation
used leased team machines; no production provider credentials were used.

The CTO decision remains whether Pi's QuickJS semantics and interrupt-based CPU
boundary are acceptable for this experimental backend. Channels and voice are
out of scope. No production database, AWS execution, main-branch write or
production deployment was used.
