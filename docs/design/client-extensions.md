# Client extensions: tenant code in the agent loop, on Workers

Status: design, not started (2026-11-12). Workers backend only; Node is out of scope. Nothing here touches
`workflow-runner`/`workflow-object`/`workflow-tools`/`workflow-notices`, which the workflow simplification is rewriting
([workflow-simplification.md](workflow-simplification.md)).

A tenant can already shape an agent with prompts, builtins, MCP servers and OpenAPI sources. What it cannot do is put
code *between* the model and the tools: deny a tool call by its arguments, rewrite a result before the model sees it,
add a tool whose logic is a few lines against its own API, or add a prompt section computed from its own state. This
design lets a tenant upload a small JavaScript bundle, a **client extension**, that camelRun installs as a pi-durable
`Extension` on the agents the tenant selects it for, runs in a QuickJS VM with no bindings and a capability API, and
pins per agent so replay and resume run the same code.

## 1. The v1 surface

### 1.1 What pi-durable offers, and what of it maps

pi-durable's `Extension` (`harness/types.d.ts`) is `{ name, tools, sections, hooks, wraps, tasks }`. Hooks are
`hook(Task, handlers)` on the built-in tasks: `GenerationTask` (`beforeRequest`, `beforeProviderRequest`,
`afterResponse`, `onYield`, `afterTools`, `afterRun`), `ToolTask` (`beforeTool`, `afterTool`) and `CompactionTask`
(`beforeCompact`). The scheduler runs the handlers of the conversation's *selected* extensions, in selection order
(`agentHooks(agent, task)` in `scheduler.js`); a handler that throws is reported as `extension_error` and the chain
goes on, except `beforeTool`, where a throw blocks the call (`tool.js`). Hooks run off the Session line against
committed reads, and a hook rerun after a crash "may see more"; `api.memo(name, candidate)` is the idempotence primitive
hooks share with their task. This is how our own `camel.*` extensions are built today: `sender-extension.ts`
(`beforeRequest`, rewrites user messages for the provider only), `tool-output.ts` and `agent-updates.ts` (`afterTool`
chains, installed in that order so the result is capped before progress rides on it), `prompt-sections.ts`
(`sections`), and the tools of `agent-tools.ts` (`registry.install(...)` in `createHarness`, install order = hook
order).

| pi-durable point | v1 client surface | Why |
| --- | --- | --- |
| `tools` | **Custom tools** (`tools` in the manifest; `execute` in the bundle) | Maps one to one: a `ToolRegistration` whose `execute` runs the bundle's function in the VM |
| `sections` | **Prompt sections** (static text, or a function of the extension state) | Maps one to one; rendered after the runtime's sections, before `instructions` |
| `ToolTask.beforeTool` | **`beforeTool(call)` → allow, deny or rewrite arguments** | Maps exactly: `{ block }` / `{ arguments }`; the first block in the chain wins |
| `ToolTask.afterTool` | **`afterTool(call, result)` → replace the result** | Maps exactly; the client's extension installs last, so it sees the capped, file-materialized result |
| `wraps` (`wrapTool`) | **Declarative overrides** of a runtime tool's `description`/`parameters` text | Maps to a pure wrapper; no code needed, only the manifest |
| *(ours, not pi's)* | **`beforeTurn(input)` → allow or deny a run** | pi's `beforeRequest` cannot stop a run (a throw is reported and ignored) and carries the whole context; our run admission can and carries the input |
| `GenerationTask.beforeRequest` | out of v1 | Would ship up to 64 messages / MiBs into the VM every request; the sender extension already owns provider-side rewriting |
| `beforeProviderRequest`, `afterResponse`, `onYield`, `afterTools` | out of v1 | Provider-format bodies and run continuation are power-user seams with no bounded input yet |
| `afterRun`, `tasks` | out of v1 | They create **durable tasks**: a client task definition would have to migrate, abort and survive restarts in our registry. Later, as "run a custom tool after the run" |
| `CompactionTask.beforeCompact` | out of v1, worth a v2 | A tenant summarizer is a real ask (compliance, domain memory) but needs a model call from the VM |
| `wrapSection` | out of v1 | Rewriting the runtime's own sections would let a tenant remove safety text we rely on |
| async I/O in hooks | out of v1 | Hooks are synchronous VM calls (1.3); custom tools get `fetch` (4.2) |

### 1.2 The bundle

One plain script (no modules; QuickJS has no loader), ES2023, evaluated once per VM, ending in a value:

```js
// extension.js — bundled with esbuild --format=iife --global-name=extension, or written by hand
({
  tools: {
    async lookup_order({ orderId }, { fetch, state }) {
      const res = await fetch(`https://api.acme.example/orders/${orderId}`);
      if (!res.ok) return { error: `order ${orderId}: ${res.status}` };
      return res.json();
    },
  },
  sections: {
    policy: ({ state }) => state.get("policyText") ?? "Follow Acme's refund policy: ...",
  },
  hooks: {
    beforeTool(call, { state }) {
      if (call.name === "web_fetch" && !/\.acme\.example\//.test(call.arguments.url)) return { block: "Only Acme pages may be fetched" };
      if (call.name === "send_message") return { arguments: { ...call.arguments, text: `[${state.get("prefix") ?? ""}] ${call.arguments.text}` } };
    },
    afterTool(call, result) {
      if (call.name.startsWith("acme__")) return { ...result, output: redact(result.output) };
    },
    beforeTurn(input, { state }) {
      if (state.get("paused")) return { deny: "This agent is paused by Acme's policy" };
    },
  },
})
```

The manifest (JSON, uploaded with the bundle) declares what the bundle may do; the bundle cannot widen it:

```json
{
  "name": "acme-policy",
  "version": "1.4.0",
  "description": "Acme refund policy, order lookup, fetch allowlist",
  "tools": [{ "name": "lookup_order", "description": "Look up an Acme order by id", "parameters": { "type": "object", "properties": { "orderId": { "type": "string" } }, "required": ["orderId"] }, "replay": "safe", "outputLimits": { "maxBytes": 65536 } }],
  "sections": [{ "key": "policy" }],
  "hooks": { "beforeTool": { "onError": "block" }, "afterTool": { "onError": "pass" }, "beforeTurn": { "onError": "pass" } },
  "overrides": { "web_fetch": { "description": "Fetch an Acme page (other hosts are blocked)" } },
  "capabilities": { "fetch": { "hosts": ["api.acme.example"] }, "secrets": ["ACME_API_KEY"], "state": true },
  "limits": { "hookPolls": 2000, "toolCpuMs": 2000 }
}
```

Manifest names use the tenant's own namespace: a tool is offered to the model as `acme-policy__lookup_order` and may
not collide with a runtime tool (`web_fetch`, `delegate`, the file tools, ...) or another extension's. Hooks see every
tool by its offered name, so `beforeTool` can gate runtime tools, MCP tools (`<server>__<tool>`) and its own.

### 1.3 Where the code runs: two execution shapes

**Hooks and sections** are *synchronous* VM calls. The host gathers the hook's input (the call and arguments, the
result, the run input), the extension's state snapshot (4.2) and a deterministic clock seed; calls one function in a
warm QuickJS context; reads back one JSON value and the state writes. No host calls happen while the VM runs, so a hook
is a pure function of its input, and there is nothing to await, interrupt or retry inside it.

**Custom tools** are *asynchronous* executions: the bundle's `execute` runs as a code-mode-style script in the sandbox
Worker (`codemode/index.ts`, `SessionCodemodeSandbox`), with the same exchange (`codemode/exchange.ts`), caps
(`SANDBOX_LIMITS`: 2 s CPU, 30 s wall by default, 128 KiB arguments, 1 MiB results, 256 calls), deadline accounting
(`sandbox.ts` `ScriptRun`) and abort as an agent's code-mode script. The only difference is the globals: not code mode's
`tools.*` catalog, but the manifest's capabilities (`fetch`, `state`, `log`, and later `tools` for nested calls, 4.2).

This split is the whole reason the design is cheap: the sandbox path exists, is bounded and billed, and keeps
long-running tenant code off the agent Durable Object; the hook path is new but tiny, and lives on the agent DO because
it sits on the critical path of every tool call.

### 1.4 Hooks on the agent DO: cost, memory, warm contexts

The agent DO today never runs QuickJS ("a separate Worker is required to keep synchronous QuickJS off the agent
thread", `codemode/index.ts`). Hooks change that for calls bounded to milliseconds. What it costs, from what we have
measured (`bench/`, [workflow-step-snapshots.md](workflow-step-snapshots.md)) and what remains to measure in PR 1:

| | Measured / estimated | Source |
| --- | --- | --- |
| Warm hook call (JSON in, one function, JSON out) | **0.3–1 ms** | v8-exec QuickJS: `return 1` p50 0.35 ms, `50 tool calls` 1.7 ms; a 128 KiB argument parse adds ~1 ms |
| Restore a context from its image (gunzip + restore) | **~7–10 ms** | snapshots doc: gunzip 2.6–3.7 ms, restore 3.5–6.4 ms, for a 1.6–2.2 MiB image → ~215 KiB gzip |
| Cold start without an image (instantiate Wasm + eval a 200 KiB bundle) | **20–60 ms, to measure** | Wrangler compiles the module at deploy; instantiation and intrinsics are the floor, the bundle's eval the variable |
| Snapshot after the bundle's init (once per extension version, 2.1) | **~5–15 ms** | snapshots doc: take 1–4 ms, gzip 8–20 ms |
| QuickJS vs V8 on compute | **~4× slower on JSON, ~11× on loops** | bench: `json transform` 49 vs 12 ms, `cpu loop` 452 vs 40 ms |
| Memory per live context | **1.6 MiB floor + the bundle's heap**, hard cap 8 MiB (`EXTENSION_HEAP_BYTES`) | snapshots doc: "the 1.6 MiB floor is the fresh VM" |
| Per-hook CPU budget | **2,000 interrupt polls**, about 10–40 ms of CPU, a tunable (`limits.hookPolls`, ceiling 5,000) | code mode's 10,000 polls keep a non-yielding script under the isolate's CPU reset; a hook gets a fifth |

So a hook costs about a millisecond when warm, a tool call costs hundreds, and the overhead is invisible unless an
extension does real work in a hook, which its poll budget ends.

**Warm context.** One QuickJS context per (agent DO, extension version), created on first use and kept in memory while
the DO is alive, dropped after `EXTENSION_IDLE_MS` (5 min) without a call, on any fault (an uncaught throw, a used-up
poll budget, heap above 90 %), and on DO eviction. The context is re-restored from the version's **warm image** (next
paragraph), so a faulty hook never poisons the next call: the extension's globals are not a place to keep state.
Memory is the constraint: agent DOs of many tenants share one 128 MiB isolate, so the agent Worker keeps a per-isolate
count of live contexts (a counter, not a cache) and above `EXTENSION_LIVE_CONTEXTS` (8, so at most 64 MiB in the worst
case, 13 MiB typical) a call restores, runs and disposes instead of staying warm (~10 ms instead of ~1 ms, still fine).

**Warm image per version, not per DO.** An extension's init is deterministic (no I/O, seeded clock, 3), so the state
of a context right after evaluating the bundle is the same in every DO. On upload (2.1) the sandbox Worker evaluates
the bundle once, takes a `quickjs-wasi` snapshot exactly as `workflow-vm.ts` does (`WorkflowVm.take`, linear memory +
header, gzip), and stores it beside the bundle in R2 keyed by version and build fingerprint
(`workflowFingerprint()` already captures `quickjs-wasi` version, Wasm hash, prelude hash, heap and stack sizes). Every
DO then starts a context by `QuickJS.restore` (~7–10 ms) instead of instantiating and evaluating (20–60 ms), and a Wasm
or prelude bump invalidates every image at once, as it does for workflow snapshots; a missing image falls back to a
cold start and is regenerated by the next upload-time job. The driver is the workflow VM's minus the effects protocol:
`WORKFLOW_PRELUDE`'s deterministic clock/PRNG and `bridge` host function, with `state`/`log` in place of
`agent`/`job`/... Shared code goes to `codemode/guest-vm.ts`; the workflow VM keeps its own file and is not touched
until the simplification lands.

**Why not run hooks in the sandbox Worker too?** A DO RPC round trip (~2–5 ms plus serialization) on every tool call,
and one of the sandbox's three 24 MiB heap slots per agent taken by a context that must stay warm, competing with
code-mode runs and workflow steps. Hooks are small by construction; the agent DO is the right place. If PR 1's
measurement shows the cold start or the memory are worse than the table, the fallback is the sandbox Worker with a
fourth, smaller slot class for hook contexts; the surface does not change.

## 2. Packaging, versioning, pinning

### 2.1 Upload

`POST /v1/extensions` (multipart: `manifest` JSON, `bundle` script; or JSON with the bundle inline), bearer tenant
key. Limits: bundle ≤ 512 KiB, manifest ≤ 32 KiB, ≤ 32 tools, ≤ 8 sections, total tool
description + parameter text under the existing catalog accounting (`CATALOG_LIMITS`); ≤ 100 versions kept per name.

The upload is checked before it is stored, in the sandbox Worker (as `checkScript` checks a workflow script today): the
bundle compiles (`EvalFlags.COMPILE_ONLY`), evaluates within 5,000 polls and 8 MiB, its value has the shape the manifest
declares (every declared tool, section and hook is a function; nothing undeclared is reachable), and the manifest's
schemas are valid JSON Schema. A failure is a 400 with the line and column (`scriptError`). On success the warm image
is taken (1.4) and the version is stored:

- the bundle and the image in R2 (`BUCKET`: `extensions/{tenant}/{id}/bundle.js`, `.../image-{fingerprint}.gz`);
- a Postgres row `extensions(tenant, name, version, id, manifest, bundle_sha256, bytes, created_at, created_by,
  deleted_at)`, `id = "ext_" + sha256(manifest ‖ bundle)[:16]` (content-addressed: the same upload twice is one id).

`GET /v1/extensions`, `GET /v1/extensions/{name}` (versions, which agents pin each), `DELETE /v1/extensions/{name}/{version}`
(soft; refused while any agent configuration pins it; the bundle is purged 30 days after the last pin goes).

### 2.2 Selection and pinning

Agent configuration gains `extensions: [{ name, version? }]`, checked in `api-contract.ts` beside `mcpServers`. At
create, configure and definition-apply time (`definitions.ts` `configurationPatch`, the same place `prepareSources`
resolves MCP servers), each entry resolves to its version id, and the configuration stores `extensionPins: [{ name,
id }]`. **The pin, not the name, is what an agent runs.** `version` omitted means "latest at the time of this
configure", never "latest at run time". Definitions carry the same field, so `applyOnUpdate` rolls a new pin to every
agent of the definition, through the configuration queue (`configuration-queue.ts`), which already applies configuration
changes between runs, never inside one: a run finishes under the pins it started with.

Inside the DO, each pinned extension installs in the registry under its id, `ext.acme-policy@ext_3f9c...` (after every
`camel.*` extension, so our `afterTool` chain runs first and our sections come first), and the conversation's
`AgentState.extensions` selects the pins. A fork or a child inherits the selection with the agent state, as it inherits
`maxTurns`. A rerun of an interrupted task (`execute` phase in `tool.js`) resolves the tool and the hooks against the
agent as it is then: with pins applied only at run boundaries, that is the same code. A version that is pinned by a
live configuration cannot be deleted, so the registry never lacks it.

### 2.3 Rollout and rollback

Rollout is `PATCH /v1/agents/{id} { extensions: [{ name, version: "1.4.0" }] }`, or a new definition revision with
`applyOnUpdate`, or `camel-run extensions pin acme-policy 1.4.0 --definition support`; rollback is the same call with the
previous version. A tenant can run two versions on two agent populations at once (that is just two pins). There is no
runtime "latest" channel on purpose: a bad upload cannot change a running fleet by itself.

## 3. Durability: what the runtime guarantees, what the author must

pi-durable's rules apply unchanged: a tool with `replay: "unsafe"` (the default) is never rerun after a crash (the call
gets an `interrupted` result); `replay: "safe"` reruns it. Hooks are rerun with their task and may see more than the
first attempt did. The extension runtime adds, on top:

**Guaranteed by the runtime**

- A hook or section is a pure function of its input: no I/O, no real clock, no entropy. `Date.now()` is the call's
  stamped time (passed in with the input, so a rerun sees the same value); `Math.random()` is seeded from the task id and
  call id (`workflow-vm.ts`'s `random_get`); the VM has no `fetch`, no timers, no host functions beyond `state`/`log`.
- The extension's **state** (4.2) is read once before the call, as a frozen snapshot; the hook's writes are collected
  and applied after the call, not during it. A hook never observes its own writes mid-call.
- A hook's outcome is **memoized** on its tool task: the runtime stores `{ output, writes }` with
  `api.memo("ext.<id>.<hook>", candidate)` before applying the writes, so a hook rerun after a crash gets the first
  attempt's outcome back and re-applies the same writes (sets and deletes, so re-applying is idempotent) instead of
  computing a second, possibly different one. This is exactly how `agent-updates.ts` keeps the reports it shows stable
  across a crash.
- `beforeTool` runs before intent is recorded (`tool.js` `call` phase), so a block or a rewrite is in the stored intent;
  `afterTool` runs before the result commits, on every result the Harness writes, including `interrupted` and `blocked`
  ones (told apart by their diagnostic codes, as `agent-updates.ts` does).
- A custom tool's `execute` is a code-mode execution: its host calls (`fetch`, `state`) are journaled by call id, and a VM
  that stops and starts again (a sandbox restart, a long wait) replays them from the journal (`sandbox.ts` `ScriptRun`,
  "the VM is deterministic, so the replay makes the same calls again, which Pi already has and never sees twice").

**The author must**

- Declare `replay: "safe"` only for a tool whose effects are idempotent (a lookup, an upsert by key). An unsafe tool that
  is cut off mid-flight leaves the model an `interrupted` result, by design.
- Keep hook logic a function of `(input, state)`; the globals of the context are a cache at best (1.4) and are reset on
  any fault.
- Treat `state` as last-writer-wins per key: parallel tool calls of one round run their hooks concurrently, each on its
  own snapshot, and their writes apply in commit order. A counter in `state` is wrong; a set of seen ids is fine.
- Keep `beforeTurn` cheap and total: it runs at admission, before anything is stored for the run.

## 4. Security

### 4.1 Isolation

The VM has no bindings, no `env`, no secrets and no network: the only host functions are the ones the capability API
registers (`bridge`, as in `workflow-vm.ts`), and the prelude takes its references to built-ins before the bundle runs,
so patching `JSON.stringify` changes nothing the host reads. A context is per (agent, extension version), so one tenant's
code never shares a heap with another's; the sandbox Worker already gives each agent its own DO. Hook contexts on the
agent DO are bounded by heap (8 MiB), stack (256 KiB) and polls per call; a context that trips any of these is disposed
and its call fails under the hook's `onError` policy (4.4). Custom tools run under code mode's caps in the sandbox,
including its `cpuMs`/`timeoutMs` and output caps.

Tenant-supplied model-facing text (tool descriptions, parameter schemas, section text, overrides) is **tenant prompt
content**, treated exactly as `systemPrompt` and MCP tool descriptions are today: it goes to the model as the tenant's
own words, counts against `CATALOG_LIMITS`, is never rendered inside the runtime's own sections, and nothing in it is
trusted by the runtime. The runtime's own sections stay first and cannot be wrapped (1.1). `tool-judge.ts` applies to
custom tools as to MCP tools where the agent has `decide`.

### 4.2 The capability API

Small on purpose; every entry is declared in the manifest and enforced by the host, never by the guest.

| Capability | Hooks/sections | Custom tools | Limits |
| --- | --- | --- | --- |
| `state` — per (agent, extension name) key/value, JSON values | `get`, `set`, `delete` (snapshot in, writes out) | same, as host calls | 64 KiB per extension per agent, 256 keys, key ≤ 128 chars; stored in the agent DO's SQLite (`extension_state(extension, key, value, updated_at)`), exported/purged with the agent, survives version changes |
| `log(...)` | yes | yes | 100 lines × 1 KiB per call; to the run's events (5) |
| `fetch(url, init)` | no | yes | `https:` only; the host must match the manifest's `fetch.hosts`, in the vault's host syntax (`docs/guides/vault.md`: exact names or `*.example.com`, the same Public Suffix rules, no IPs, ports or private names), **and** the agent's own `networking` policy when it is `limited`; the call goes through the host, through `security-outbound.ts` (address guard with DNS, redirects disabled); 32 calls per execution, 10 s each, 1 MiB body, no streaming; headers the tenant sets are sent, nothing from the runtime is added |
| `tools.<name>(args)` — nested runtime tool calls | no | **v1 if cheap**: the exchange already carries code mode's calls; manifest `capabilities.tools: ["web_fetch"]` | code mode's call caps; through `executeTool`, so `beforeTool` hooks see the nested call with `parent` set |
| `now()`, `random()` | deterministic (3) | deterministic per execution start | — |
| secrets | no | **v1, through the vault**: the manifest attaches vault references (`capabilities.secrets: ["STRIPE_KEY"]`), the guest puts `camel-vault-STRIPE_KEY-placeholder` in a header, and the host substitutes the sealed value only for a destination the secret's own `allowedHosts` permit, as native computers do today; the value is never readable by the guest and is masked in responses | the vault's existing rules (`vault.ts`) |

### 4.3 Resource limits, per tenant

Beyond the per-call limits: at most 16 extension versions pinned per agent, 8 live hook contexts per isolate (1.4),
custom tool executions share the tenant's code-mode concurrency (`CODE_LIMITS.concurrent`), and a hook that fails
`EXTENSION_FAULTS_PER_HOUR` (20) times on one agent is **disabled for that agent until its next configure**, with an
event the tenant sees (5): a broken extension must not turn every tool call into a block or a 10 ms restore.

### 4.4 Fail-open or fail-closed, per hook

| Hook | Default on error, budget or disabled | Manifest `onError` |
| --- | --- | --- |
| `beforeTool` | **closed**: the call is blocked with `Tool call blocked: extension acme-policy failed (...)` (pi already blocks on a throw; a guard that cannot decide must not allow) | `"pass"` for an advisory hook |
| `afterTool` | **open**: the result passes unchanged, plus an `info` diagnostic the model sees (`extension acme-policy did not run`) | `"error"` to turn the result into an error result |
| `beforeTurn` | **open**: the run is admitted | `"deny"` for a gate that must hold |
| section | **open**: the section is omitted this request | — |
| custom tool | an `isError` result with the message; never a crash of the run | — |

Whatever the policy, every failure is reported (5).

## 5. Billing and observability

**Billing: nothing new in v1.** Agent time ($0.01 per hour in a run, `docs/pricing.md`) already covers the wall time a
run spends in hooks and custom tools, and code-mode executions are not priced separately today, so custom tools ride
on the same line. Hook CPU is bounded to tens of milliseconds a call, and custom tools to code mode's 2 s CPU by default,
so nothing a tenant can do here moves the cost of a run by more than a few percent. We **meter** it anyway: every hook
call and tool execution writes a `METRICS` (Analytics Engine) point with tenant, extension id, hook or tool, outcome,
polls or CPU ms, wall ms, heap bytes, input and output bytes. If the metered CPU ever matters, a per-execution CPU price
on the `usage.recorded` line (a new `kind: "extension"`, as `computer` and `decision` were added) is a small change; it
is not worth a price and an invoice line before there is a number.

**Tenant-visible.** Each hook failure, budget overrun, disablement (4.3) and `log()` line is an event on the run's
stream (`type: "event"`, `event: { type: "extension_error" | "extension_log", extension, hook, message }`, beside
`spend_limit_reached`), so the console shows it in the run and the SDK's `watch` delivers it. `GET /v1/extensions/{name}/errors`
returns the last 200 failures across the tenant's agents (a small ring in the tenant object, `tenant.ts`, fed by the
agent DO's reports the way `recent-events.ts` keeps an agent's own), with the agent, run, hook and message. A `beforeTool` block shows in the transcript as any
block does, naming the extension. Nothing of the arguments or results an extension saw is logged by the runtime
(`log()` is the tenant's own choice).

**Operator-visible.** The same metrics, plus `console.warn` lines `extension_fault`, `extension_context_evicted`,
`extension_image_missing` with tenant, id and the reason, for `ops-reports.ts`.

## 6. API, SDK, docs

**API** (`docs/reference`, OpenAPI): `POST/GET /v1/extensions`, `GET /v1/extensions/{name}`,
`DELETE /v1/extensions/{name}/{version}`, `GET /v1/extensions/{name}/errors`; `extensions` on `POST /v1/agents`,
`PATCH /v1/agents/{id}` and definitions; `GET /v1/agents/{id}/extensions/{name}/state` and `PUT` (for support and
tests; the console shows it read-only). The routes belong to the API token's tenant, and the token kinds that cannot
manage the vault (OAuth tokens) cannot manage extensions either: an extension is code with the tenant's reach.

**TS SDK** (`clients/typescript.ts`): `client.extensions.upload({ manifest, bundle })`, `.list()`, `.get(name)`,
`.delete(name, version)`, `.errors(name)`; `extensions` in `AgentConfiguration`; and a typed authoring package,
`@camelai/run-extension`, that exports the `Extension`, `HookContext`, `ToolContext` types and a `defineExtension()`
identity so a bundle type-checks against the capability API. `create-run-app` gets an `extension` template with the
esbuild line. **Python** (`clients/python`): `client.extensions.upload(manifest=, bundle=)` and friends; no authoring
package (bundles are JavaScript).

**CLI**: `camel-run extensions upload ./acme-policy`, `list`, `pin <name> <version> --agent|--definition`, `errors <name>`.

**Docs**: `docs/guides/extensions.md` (what, the bundle, the manifest, limits, the durability rules of 3 in the
author's terms, the fail policies), a reference page for the capability API, and a paragraph in `tools.md` and
`definitions.md` pointing to it. `docs/llms-full.txt` regenerates from them.

## 7. Implementation plan

Each PR is independently shippable and reviewed; estimates are agent days with review.

| PR | What | Size |
| --- | --- | --- |
| 1 | **Guest VM for extensions** (`codemode/guest-vm.ts`): the deterministic driver and prelude extracted from the workflow VM's shape (not its file), `state`/`log` bridge, per-call poll budget, warm image take/restore, fingerprint. Unit tests in process (Node) with the measurements of 1.4 filled in and written into this doc. No wiring | 2 days |
| 2 | **Storage and upload API**: `extensions` table and migration, R2 layout, `POST/GET/DELETE /v1/extensions`, upload-time check in the sandbox Worker (compile, evaluate, shape, image), key scopes, limits. Tests on the routes | 2 days |
| 3 | **Pinning**: `extensions` in agent configuration and definitions, `extensionPins` resolution in `api-contract.ts`/`definitions.ts`, refusal to delete pinned versions, configuration-queue application. Tests on configure/apply/fork inheritance | 1.5 days |
| 4 | **Hooks and sections in the agent DO**: `client-extension.ts` builds the pi `Extension` from a pin (install after `camel.*`), `beforeTool`/`afterTool` with memoized outcomes and state writes, sections, declarative overrides as `wrapTool`, warm context lifecycle and the per-isolate counter, fail policies, fault counting and disablement, metrics and run events. Miniflare tests on blocks, rewrites, crash rerun (memo), and eviction | 3 days |
| 5 | **`beforeTurn`** at run admission (`agent-admission.ts`/`prompt-admission.ts`), with the same fail policy and events | 1 day |
| 6 | **Custom tools in the sandbox**: `execute` as a code-mode execution with capability globals (`fetch` through the outbound policy, `state` as host calls, `log`), replay policy from the manifest, `tool-judge` coverage, output limits. Miniflare tests with a fake upstream | 2.5 days |
| 7 | **SDKs, CLI, console, docs**: TS and Python clients, `@camelai/run-extension` types, CLI, console page (versions, pins, errors, state read-only), `docs/guides/extensions.md`, OpenAPI | 2 days |
| 8 | **Pilot and canary**: one internal extension (a fetch allowlist for camelCode) on the pilot, a day of metrics, then on for tenants behind `EXTENSIONS_ENABLED` per tenant (as `workflowsEnabled`) | 1 day + watch |

About 15 agent days; PRs 1–3 can run in parallel, 4–6 depend on 1 and 3, 7 on 4–6. `tools.<name>` nested calls (4.2)
join PR 6 if it stays under a day there, else become PR 9.

## 8. Dynamic Worker Loaders: when they are worth it

We have Loader access. A loaded Worker gives tenant code a real V8 isolate: JIT speed (~4–11× QuickJS on compute),
native `async`/`fetch`/streams/WebSockets, ES modules, npm-sized bundles, and `globalOutbound` to enforce the fetch
allowlist at the platform instead of in our host. What it costs: every hook call becomes a Worker request over a
service binding (~1–3 ms round trip, more under load, and the same serialization), each tenant extension is an isolate
of its own (a few MiB, platform-managed, cold start on first use after eviction, measured in tens of ms), and it is
billed as Worker requests and CPU (on the order of $0.30 per million requests plus CPU time) on top of the agent DO's
duration, against QuickJS's share of the DO's own CPU and GB-s.

For v1, QuickJS wins on every axis that matters for hooks: a warm hook is a millisecond in-process, memory is ours to
bound, and determinism is by construction (no real clock, no entropy, no I/O), which a V8 isolate cannot promise. Loaders
become worth it for a **heavy extension**: compute over large results (a 1 MiB JSON reshaped on every tool call is ~50 ms
in QuickJS, ~12 ms in V8), streaming or long-lived connections, or a bundle that will not fit 512 KiB. The design keeps
that door open without changing the surface: the manifest's `runtime: "quickjs" | "worker"` selects the executor, the
capability API is the same host protocol either way (the Worker side calls a service binding instead of `bridge`), and
`worker` is an opt-in per tenant with its own price line, after a measurement on the pilot. Not before there is a tenant
that needs it.

## 9. Open questions for Miguel

1. **Hooks on the agent DO** (1.4) versus a fourth slot class in the sandbox Worker: the doc argues for the DO on
   latency and slot pressure, with memory bounded by the per-isolate counter. OK to decide after PR 1's measurement, or
   do you want the sandbox from the start?
2. **`beforeTurn` at admission, not pi's `beforeRequest`** (1.1): it can deny but cannot see or edit the context. Enough
   for v1, or should a bounded `beforeRequest` (last N messages, replace only user text) be in scope?
3. **Nested runtime tool calls from custom tools** (4.2 `tools.<name>`): in v1 (it is the code-mode exchange) or held
   until a tenant asks?
4. **Billing**: metered only, no price in v1 (5). Agreed, or add the `usage.recorded` line from the start so the
   console shows it even at $0?
5. **Namespace**: tools offered as `<extension>__<tool>` (as MCP's `<server>__<tool>`), or let the manifest choose bare
   names that only must not collide?
