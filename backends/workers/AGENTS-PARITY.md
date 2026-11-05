# Agents parity experiment

This is the agents track for `codex/workers-parity`. It is experimental and is
not a production rollout. The branch was rebased onto the money track before
the final tests. The current scorecard is in `ELEGANCE.md`; the raw assertions
and deployed code-mode probe are in `measurements/`.

## Agent surface

- Definitions carry revisions, apply updates, retain per-agent overrides, and
  provision agents. Stateless runs use the same durable execution path and stay
  out of the ordinary agent list.
- Agent creation and configuration use the source model/output/run-limit
  schemas. Structured output supports the native `final_output` tool and a
  bounded correction when the model omits or violates its schema.
- Model selection supports `camelrun/default`, virtual-model fallback,
  OpenRouter pass-through, custom OpenAI chat/Responses and Anthropic providers,
  scoped credentials, bearer-only Bedrock, model options, and stream deadlines.
  Provider attempts use the money track's journal, including compaction calls.
- SDK/client tools, MCP tools, remote MCP and OpenAPI sources have independent
  exposure rules. Source configuration supports refresh, selection, approvals,
  sealed credentials, runtime identity, and token exchange. Tool invocation
  identities use the money track's canonical signer and public JWKS.
- Import, export and fork retain conversation messages and configuration.
  Forked agents have independent files and request state.
- Human inputs are durable Pi documents. Questions, approvals and forms survive
  a hard restart. An answer creates a durable resume request; projection waits
  for that alias before sending resumed tool results to SDK streams.
- Delegation reuses source depth, parallelism and budget policy. Children have
  their own objects and journals. Cancellation, completion notifications,
  progress and signed parent/child messaging are durable and deduplicated.
- The UI AI SDK consumes the ordinary event stream. Text, tools, approvals,
  questions, completed reconnects and mid-answer reconnects are covered by the
  original five assertions.

## History and execution

`AgentHistory` maintains a SQLite ordinal index over the Pi journal. Incremental
indexing reads 128 entries at a time; HTTP paging bounds both message count and
serialized bytes. The test imports 1,302 messages, pages both directions, resets
the model context and compacts it while retaining the public history. An
unpaged response still has a 64 MiB safety limit; callers can page beyond it.
The active Pi model context is still materialized by Pi and is a separate memory
limit from HTTP history.

Code mode uses stock Pi `RemoteCodemodeSandbox`, native tool replay and native
pause/resume. Each agent session selects one sandbox object by its session key.
The object uses a 24 MiB VM limit and admits at most three concurrent scripts.
The source `fs` shim is the only script prefix. Workflows are scripts that call
`tools.delegate`; they can pause for human input without a second workflow
engine. Host SDK `execute` uses a separate Pi conversation so it does not add
messages to the model history.

The deployed probe checked arithmetic, a 40 MiB allocation failure, the fourth
concurrent script being refused, and cancellation. Both temporary Workers and
the sandbox namespace were deleted. Estimated marginal spend is below $0.01;
the account invoice has not settled. See
`measurements/agents-codemode-cloud.json` for the request counts and cleanup.

## Source reuse

The `scripts/reuse-*.mjs --check` scripts verify generated source fragments for
model options, output validation, run failures, prompts, decisions, delegation,
human inputs, code-mode `fs`, reset policy, OpenAPI and spending. Common money,
identity and security policy remains owned by the money track. The image path
is unchanged; per-request provider fetch is the seam for the separate streaming
image work.

## Remaining limits and decisions

- Pi's VM timeout/interrupt mechanism does not provide the v8-exec process's
  exact OS-enforced CPU accounting. The CTO must decide whether that difference
  is acceptable for this experimental backend or requires an external execution
  boundary. Memory, concurrency, wall time, cancellation and output limits are
  independently bounded.
- Platform-funded auxiliary web/decision calls require the same prepaid hold
  and end-user policy as model calls. The adapters refuse unsupported platform
  funding before dispatch; they do not claim paid production parity.
- Binary/multipart OpenAPI requests, file/image attachments, computers and
  scheduling semantics depend on the platform track. Their original failing
  assertions remain in the full scorecard. Channels and voice are excluded.
- `judged` source approvals currently ask a person conservatively. They do not
  use the source runtime's model-based judgment. MCP discovery refresh is
  explicit; server `list_changed` notifications do not trigger automatic
  refresh. Detailed source errors are not yet attached to the run result.
- Native Pi reports `script`, `sandbox` and `aborted` code-mode error kinds;
  some exact v8-exec error names differ even though the resource bounds apply.
- Large active contexts, massive request-record retention, regional Hyperdrive
  fan-out, and a fenced migration still need separate qualification. Passing
  public paging and local restart tests does not establish those properties.
- Active runtime is charged when a run segment completes or pauses. Source-style
  periodic active-time accrual is not implemented; token attempts have their
  separate durable accounting journal.

## Final validation

| Command                                                             | Result                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `npm ci` and `npm run typecheck`                                    | Pass                                                                   |
| `npm test`                                                          | 287/287 pass                                                           |
| `npm run test:integration`                                          | 54/54 pass, including local Docker computers and hard workerd restarts |
| `npm run test:compat`                                               | 89 pass, 18 fail, 39 not applicable; exits nonzero                     |
| `npm run test:python`                                               | 52 pass, 6 fail, 2 excluded voice tests; exits nonzero                 |
| All 17 `scripts/reuse-*.mjs --check` scripts                        | Pass                                                                   |
| `npm run build`                                                     | Both dry-run bundles pass                                              |
| Root `npm run docs` and the anchored `llms.txt` freshness/link test | Pass                                                                   |

The 146-case scorecard moves from 50 to 89 passes and from 57 to 18 failures.
The original decisions and UI suites each pass all five cases. OpenAPI sources
pass 2/2, SDK server 9/9, lazy connections 4/4, and multi-agent 1/1. Python moves
from 29 to 52 passes. Remaining failures cover the seven computer API cases,
four image generation cases, one calendar/email case and six Python
file/image/project/end-user/webhook cases. No failure was reclassified as a
pass or excluded to produce this delta.

`measurements/agents-validation.json` indexes the exact commands and failures.
The final unit, integration, Python and compatibility logs are in
`measurements/`. The docs test uses `test/compat-register.mjs` to resolve the
isolated Workers dependencies because root dependencies are not installed.

The implementation is rebased onto `017da3c0` on `codex/workers-parity`. The
contract track had not landed at the final fetch, so this uses the unchanged
original assertions and the local integration suite.

No production database,
AWS execution, real model-provider credential, or main-branch write was used.
