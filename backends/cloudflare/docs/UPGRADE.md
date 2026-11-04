# Prototype dependency refresh — 2026-11-04

`npm view` reports Pi Durable, Pi AI, Chord and Pi Codemode 1.5.0,
Agents 0.33.0, Computer 0.9.0 and Wrangler 4.157.0 as latest.
These versions are pinned here; the root package and vendored Pi are unchanged.
Pi Schema 1.5.0 is now an explicit peer dependency.

Reviewed Pi Durable and Codemode READMEs at v1.4.0 and v1.5.0,
the 1.4.0/1.5.0 changelog sections, Agents 0.31.0 through 0.33.0 release
notes, and the installed Agents Pi guide and implementation. There are no
intervening Pi releases. Codemode's 1.4 section is empty and 1.5 changes its
README schema example. Its remote runtime and deterministic protocol are unchanged.

Relevant changes:

- Pi AI no longer exports TypeBox. Computer's schemas are already JSON Schema;
  pass them directly. New schemas use Pi Schema's closed object builders.
- `PiSession.events()` and `AgentEvent` were removed. `session.watch()` returns
  a bounded `ConversationView` and tagged watch calls. The adapter projects this
  view into the existing camelRun SDK stream. Durable input labels associate
  batched entries with their request, independently of the latest live run.
- Pi stores progress at most every 1,000 ms by default rather than each partial.
  Watch values are live; they can precede durable storage. Terminal results are
  durable. A crash may lose roughly one second of partial output.
- View entries span resets/compaction and page through `session.entries()`.
  `ConversationTranscript` is the upstream full-transcript UI helper. This API
  adapter retains its existing history endpoint and bounded live window.
- Pi storage batches commits and its SQLite executor adds `runCounted`. Agents'
  `PiHarness` supplies the updated adapter and Lifecycle wake job; no custom
  storage/scheduler adapter is needed.
- Crash-looping tasks now end rather than park. Interrupted model requests consume
  retry attempts. `continue()` and `maxTurns` are new session controls.
- Once written by Pi 1.5, session state cannot be opened by Pi 1.4.
- Agents 0.32 changed skills loading and incremental argument parsing; this
  prototype uses no skills loader. 0.33 uses Pi's argument parser and rejects
  malformed complete tool arguments.
- Computer 0.9 retains the Workspace, WorkerJavaScriptBackend and Pi tool bridge
  used here. Its Container backend and WorkerShell backend remain experimental.

Sources:

- https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/CHANGELOG.md
- https://github.com/earendil-works/pi/blob/v1.5.0/packages/codemode/CHANGELOG.md
- https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/CHANGELOG.md
- https://github.com/earendil-works/pi/blob/v1.5.0/packages/chord/CHANGELOG.md
- https://github.com/cloudflare/agents/blob/main/packages/agents/CHANGELOG.md
- https://developers.cloudflare.com/agents/harnesses/pi/

Validation: `npm run typecheck`, `npm test` (6 assertions),
`npm run test:integration` (9 scenarios plus parent), `npm run build`.
The integration runner resolves the unchanged parent SDK's TypeBox dependency
from this package so installing parent runtime dependencies is unnecessary.
