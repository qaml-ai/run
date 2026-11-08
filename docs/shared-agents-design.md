# Shared agent links: design

Status: proposal (2026-11-08), not built. Goal: an agent's owner shares it with a link. People who open the link sign
in, and then share one conversation with the agent, like a group chat. camelCode has no web app of its own, so this is
its UI. The design works for any camelRun agent. The decision inbox (`docs/inbox-and-peers-design.md` on branch
`claude/inbox-peer-design`, PR #752) gets its console page, and items addressed to a guest show in that guest's inbox.

## Recommendation

1. **A share is two Postgres tables, `agent_share_links` and `agent_members`.** Both backends use them, because
   Workers reads the same migrations over Hyperdrive. A link only lets someone join. Membership is what grants
   access, so revoking a link does not remove anyone, and removing a member closes their streams.
2. **A guest is a signed-in console user acting through a new route prefix, `/v1/shared-agents/:id/*`.** The runtime
   checks the membership, then calls the owner's agent on the owner's tenant. It always sets `from` and `actor` to
   the member itself. The `/v1/agents/:id/*` routes and `owns()` stay as they are.
3. **The agent sees who wrote each message through the existing `from` block, plus a runtime-only `role`.** The
   model-facing change is one added instruction line.
4. **The owner pays, because the turn runs on the owner's agent.** An optional cap per member per day is tracked from
   `model_attempts.context.actor`, which every attempt already records. It is enforced when a run is admitted, and
   inside a turn as the run's `spendLimit`.
5. **Guests get the agent's capabilities, not the owner's controls.** An approval asked in a guest's turn goes to the
   owner and the definition's approvers, never to the guest. Guests cannot steer, change configuration, see files
   beyond what the agent presents, or see costs.

## What exists today

**The console**
- React 19, Tailwind 4 and radix-ui, built by Vite with base `/console/` (`console/vite.config.ts:9-17`,
  `package.json:113-124`).
- It uses its own small router (`console/web/lib/router.tsx:5-68`). The route switch is in `console/web/main.tsx:114-127`.
  Signed out, `main.tsx:76-82` renders `<SignIn>`, and a few pages bypass sign-in (`:181-183`).
- Node serves it at `/console/*` (`src/node.ts:625-650`, `:1323`). Workers serves it from `PUBLIC_ASSETS`
  (`backends/workers/src/journey.ts:54-85`). Both use a CSP with `connect-src 'self'`.
- It calls the same `/v1` API with the session cookie. Mutations send `X-Agent-Runtime-Console: 1`
  (`console/web/lib/api.ts:4`, `:30-39`).
- The agent page polls. `GET /v1/agents/:id` runs every 5 s, and `/history` every 3 s while the agent runs
  (`console/web/pages/agent.tsx:340-342`). "Try it" posts `/prompt`, then polls the request every second (`:134-164`).
- No code in `console/web` opens an EventSource.
- `@camelai/run-react` has a streaming `<AgentChat>` (`packages/react/src/index.tsx:76`, `packages/react/src/ui/*`),
  which the console does not use. Studio is loopback-only and "not multi-tenant auth" (`studio/README.md:26`).

**Sign-in and identity**
- Sign-in methods are GitHub, Google (OIDC, verified email only, `src/console-auth.ts:336`) and password. Self sign-up
  and reset by mailed link work when mail is configured (`src/console-auth.ts:217-223`). There is **no email-code
  sign-in**. `start-code.tsx` is the quickstart page.
- Sessions use the `ar_session` cookie: HttpOnly, SameSite=Lax, 12 h, stored as sha256 (`src/console-auth.ts:56`,
  `:97-109`, `:150-161`; `migrations/053_console_sessions.sql:5-19`).
- The Workers copy is generated from it (`backends/workers/src/account-console-auth.ts:1`).
- **One person is one tenant.** There are no users, members, invites or roles. The principal is
  `{tenant, via, tokenId?}` (`src/accounts.ts:21`), and its label is the Google email, the GitHub login or the password
  email (`:108-111`). Workspaces group resources inside a tenant and hold no people (`migrations/085_workspaces.sql:1-22`).

**Agents and access**
- An agent's only owner column is `agents.tenant` (`migrations/001_coordination.sql:60-71`). Routes check it with
  `clients.owns` (`src/api.ts:346-350`) on Node, and `Directory(env, tenant).get`
  (`backends/workers/src/index.ts:270-272`) on Workers.
- Browser tokens (`abt_`) are stateless HMACs. They are read-only, last at most 1 h and cannot be revoked
  (`src/browser-tokens.ts:17`, `:25-34`; GET-only, `src/api.ts:174`, `:335-345`). They are no basis for guests.
- `clients/handler.ts` is today's pattern for a shared agent: the app's server writes, with
  `from: {id: auth.userId, name}` (`:413`, `:442-444`). `docs/frontend.md:340-371` describes it.

**Sender identity**
- `PromptInput.from` is `{id, name?, username?, thread?}`, strict, each value at most 200 characters
  (`src/sender.ts:41-49`).
- `actor` defaults to `from.id` (`src/client-sessions.ts:1760`; Workers `agent-admission.ts:522`).
- Only `from` reaches the model, as a block only the runtime writes (`src/sender.ts:16-17`, `:66-69`, `:115-123`). It
  is rendered when the model is called (`src/agent-host.ts:995`; Workers `sender-extension.ts:6-38`).
- The system prompt explains the block (`SENDER_INSTRUCTIONS`, `src/sender.ts:30-34`; Workers `sender-markers.ts:16`).
- Channels already put several senders in one conversation (`src/core/channels/channels.ts:178`). camelCode lists
  Slack approvers as `slack:U…` (`~/camel-code/src/project.ts:17`), and its prompt says "Several people talk to you"
  (`:141`).

**Batching**
- `joins` merges two prompts only when both their actor and their bucket are equal (`shared/queue-mode.ts:46-48`).
  `batchable` excludes prompts with a `spendLimit` (`:34-40`).
- Node takes the next batch in `batchOf` (`src/client-sessions.ts:2400-2412`). Workers holds prompts in
  `BatchQueue.holds` (`backends/workers/src/batch-queue.ts:52-64`).

**Billing**
- The payer is the agent's `subject`, else the tenant (`src/client-sessions/spend.ts:274-281`; Workers
  `agent-billing.ts:74-76`).
- A bucket a run names becomes the agent's sticky `runBucket` (`src/client-sessions.ts:1776-1780`; Workers
  `agent-admission.ts:656`). A per-guest bucket would therefore leak into schedules and channel turns. This design
  does not use buckets.
- Every model attempt stores `context.actor` (`src/model-attempt.ts:11`, `src/client-sessions.ts:873`; Workers
  `model-metering.ts:86`), and `settle` posts the charge (`src/model-attempts.ts:235-316`).

**Streams**
- `GET /v1/agents/:id/events` is SSE with replay and a `?poll=1` fallback (`src/api.ts:660-686`).
- An agent takes at most 32 watchers, 1,024 per tenant (`src/client-sessions/events.ts:54-57`, `:229-240`; Workers
  `agent-transport.ts:113-149`).
- `endStreams` closes every stream of an agent (`events.ts:365-368`). Neither backend can close one viewer's stream.
- History user messages carry `from` (`docs/reference/events.md:223`). `GET /v1/agents/:id` reports `busy`,
  `activeRun` and `queuedRuns` as a count only (`src/api-schemas.ts:596-598`).

**Human input**
- `responders` is the audience (the run's actor) plus the definition's approvers, frozen when the input is made
  (`src/client-sessions/inputs.ts:81`, `src/inputs.ts:296-298`; Workers `human.ts:110-113`).
- `mayAnswer` matches `from.id ?? actor` against it (`src/inputs.ts:182-189`).
- Kinds are `question | approval | form | url` (`src/inputs.ts:19`).
- The GIN index on `responders` (`migrations/117_agent_inputs_inbox_index.sql`) is not prefixed by tenant, so a query
  across tenants uses it.

## Data model

One migration. The tables live in Postgres, which both backends share.

**`agent_share_links`**

| Column | Notes |
| --- | --- |
| `id text pk` | `asl_` + 16 hex. The public id the owner sees, never the secret. |
| `tenant`, `agent` | The owner and the agent. Links are refused for a sub-agent. |
| `sha256 bytea unique` | Hash of the 32-byte random secret. The secret is shown once and never stored. |
| `created_at`, `expires_at null` | Default 7 days. The owner picks 1 day, 7 days, 30 days or never. |
| `revoked_at null` | Set by revoke. |
| `joins int`, `last_joined_at` | For the owner's list. |

**`agent_members`**

| Column | Notes |
| --- | --- |
| `id text pk` | `m_` + 16 hex. The agent sees `member:<id>`. |
| `tenant`, `agent` | The owner and the agent. |
| `person text` | The member's own tenant id, never shown to the model or to other guests. |
| `role` | `owner` or `guest`. One owner row is made when the first link is created. |
| `name`, `email` | Copied from the sign-in at join, and refreshed on each visit. `email` is shown to the owner only. |
| `link null` | The link they joined through. |
| `added_at`, `removed_at null` | A removed person cannot rejoin through a link until the owner restores them. |
| `daily_cap bigint null` | Same unit as `model_attempts.charge`. Null means no cap, the default. |
| `revision int` | Increases on every change. Streams compare it. |

Indexes: `unique (agent, person)` and `(person) where removed_at is null`, which serves "agents shared with me" and the
inbox. When an agent is deleted, the runtime sets `removed_at` on its rows in the same path.

**`agent_member_days`**: `(member, day) pk, charge bigint`. When `settle` finds `context.actor` starting with
`member:`, it upserts the charge delta in the transaction that already posts it.

**Identity mapping**

| Runtime field | Guest turn | Owner turn from the console |
| --- | --- | --- |
| `from` | `{id: "member:m_…", name, role: "guest"}` | `{id: "member:m_…", name, role: "owner"}` (once the agent is shared) |
| `actor` | `member:m_…` (forced) | `member:m_…` |
| `bucket`, `subject` | the agent's own. Guests cannot set them. | unchanged |
| payer | the agent's tenant, or its `subject`, as for any turn | unchanged |

An app that prompts through the API is unchanged. A Slack message keeps `from: slack:U…` and shows in the same thread,
labelled with its name.

The id is per agent (`m_…`), not the person's tenant. Owners cannot correlate a guest across agents, and the model
never sees a tenant id.

`role` is a new key in `Sender`. `senderInput` keeps rejecting it from API callers (`src/sender.ts:41-49`). Only the
shared routes and the console session path set it.

## API

**Owner**: a console session or an API key of the agent's tenant, under the existing `owns` check.

| Method | Path | Body / result |
| --- | --- | --- |
| POST | `/v1/agents/:id/share-links` | `{expiresIn?: seconds \| null}` → `{id, url, expiresAt}`. `url` is `<origin>/console/join#t=<secret>` and is returned only here. |
| GET | `/v1/agents/:id/share-links` | live and revoked links, without secrets |
| DELETE | `/v1/agents/:id/share-links/:link` | revoke. Members stay. |
| GET | `/v1/agents/:id/members` | `[{id, name, email, role, addedAt, removedAt, dailyCap, spentToday}]` |
| PATCH | `/v1/agents/:id/members/:m` | `{dailyCap?: usd \| null, removed?: false}` (the second restores a member) |
| DELETE | `/v1/agents/:id/members/:m` | remove. Closes their streams and cancels their queued runs. |

When an owner prompts from the console on a shared agent and gives no `from`, the server stamps the owner member. This
is server-side, so every console tab does it the same way.

**Guest**: a console session only. API keys are refused, so a guest's own scripts cannot act as them. This is an open
question below.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/v1/share-links/join` | `{token}`. Valid, unrevoked and unexpired → the member, created or refreshed. Refused when the person was removed (409 `removed`). The owner joining their own link is a no-op. |
| GET | `/v1/shared-agents` | agents shared with me: `{id, name, owner: {name}, role, unread?}` |
| GET | `/v1/shared-agents/:id` | `{name, description, me, members: [{id, name, role}], busy, running: {requestId, from} \| null, queued: [{requestId, from}]}` |
| GET | `/v1/shared-agents/:id/history` | the owner's `/history`, filtered |
| GET | `/v1/shared-agents/:id/events` | SSE, the owner's stream, filtered, tagged with the member |
| POST | `/v1/shared-agents/:id/prompt` | `{text, files?}` only. The runtime sets `from` and `actor`, always queues (never steers), and returns 202 `{id}`. |
| PUT | `/v1/shared-agents/:id/uploads/:rid/:name` | as the owner's uploads route, with the same limits |
| POST | `/v1/shared-agents/:id/stop` | stops the running turn only when it is working for me (`abort {queued: "keep"}`); 409 otherwise |
| POST | `/v1/shared-agents/:id/leave` | sets `removed_at` and allows rejoining |

On Node, the guard is a handler next to the browser-token guard (`src/api.ts:335-350`). On Workers, it sits beside the
`Directory` lookup (`backends/workers/src/index.ts:270-294`). Each request reads the member row by `(agent, person)`.
The lookup is a primary-key read and is not cached.

**Filtering for guests**
- Frames and history keep messages, tool calls and results, `file_presented`, `input_*` and `batch_taken`.
- They drop cost and `usage` (the browser filter already does this: `src/browser-tokens.ts:107-125`).
- Sub-agents send only `subagent_start`, `subagent_progress` and `subagent_end`, never nested events.

**New stream frames, on both backends**
- `request_queued {requestId, from}` when a prompt is accepted behind a turn.
- `request_started {requestId, from}` when its turn opens.
- User `message_end` frames carry `from`, as history does.
- These feed "working for Dana · 2 queued" without polling.

**Guests cannot**
- Use `/v1/agents/*`, configuration, schedules, credentials, fork, delete or other agents.
- Read volumes or the Files tab. They get only the signed links of `present_file`.
- See usage or billing. A guest sees only their own cap status ("today's limit reached").
- Set the bucket, spendLimit, runLimits, output, metadata or steer.
- Stop someone else's turn.

**Inbox**
- `GET /v1/inbox` (inbox slice 4) adds, for a console session, the pending items whose `responders && <my member
  ids>`, from any tenant. They are tagged `shared: {agent, owner}`.
- `POST /v1/inbox/answers` accepts them with `from` forced to that member. `mayAnswer` decides.
- `GET /v1/inbox/events` adds the member ids to the watcher's filter.

## What the agent sees

The context block (the existing format, with `role` added):

```
<<<RUNTIME_CONTEXT>>>
{"from":{"id":"member:m_3f9a1c2d4e5b6a70","name":"Dana Lee","role":"guest"}}
<<<END_RUNTIME_CONTEXT>>>
```

`name` comes from the sign-in: the Google name, the GitHub name or login, else the part of the email before the @. It
is never the email itself. Guests see each other's names.

The only new model-facing text is one line appended to `SENDER_INSTRUCTIONS`, on both backends, and only while the
agent has a member:

```
- from.role, when present, is set by the runtime: "owner" is the person who owns this agent, "guest" is someone they shared it with. Everyone in this conversation reads every message and reply. Only the owner can approve actions.
```

Nothing else changes for the model. The note `(Answered by Dana Lee after 3m.)` already uses `from.name`
(`src/inputs.ts:76-79`, `:256`). The line is added at the first share and removed with the last member, so the prompt
cache changes once per change.

## Security

- **Tokens.** 32 bytes from the CSPRNG, base64url, in the URL fragment (`/console/join#t=`), as email links do
  (`console/web/pages/email-link.tsx:14-15`). The fragment stays out of server and proxy logs. The runtime stores only
  the sha256 and compares hashes by primary-key lookup.
- **Sign-in before joining.** `/console/join` keeps the secret in `sessionStorage` across the sign-in redirect, then
  posts it once and clears it. A new sign-up records `signup_source = "shared_link"` (`migrations/091`). Google accepts
  only verified emails, and password sign-up verifies by mailed link. With no mail configured on a self-host, joining
  needs Google or GitHub.
- **Removal is immediate.**
  - Node watchers and Workers socket watchers carry `member` and `revision`. `DELETE …/members/:m` calls a new
    `endMember(agent, member)`. On Node it closes the matching watchers (beside `endStreams`, `events.ts:365`). On
    Workers the DO closes the matching sockets with 1008 `{reason: "removed"}`, as expiry does today
    (`agent-transport.ts:294-299`).
  - As a backstop, a guest stream re-reads its member row every 5 minutes and closes if the row changed.
  - The member's queued runs are cancelled (`run_cancelled`). A turn already running for them finishes.
- **Rate limits, sized far above human use.** No daily cap applies except the one an owner sets.
  - Prompts: 30 a minute per member per agent.
  - Joins: 20 a minute per session and per IP.
  - Link creation: 100 an hour per agent.
  - Members: 1,000 per agent.
  - The 32-watcher limit stays. On a 429 the console falls back to `?poll=1&wait=25`.
- **Prompt injection.** A guest can ask the agent to do anything its tools allow without an approval: read the
  project volume, push a branch, spend. This is the cost of "the agent keeps its capabilities".
  - **The share dialog says so in one sentence.**
  - **An approval asked in a guest's turn has responders = the owner member + `humanInput.approvers`.** The guest is
    not among them. This is set in `src/client-sessions/inputs.ts:81` and Workers `human.ts:110-113`, keyed on
    `kind: "approval"`. Questions, forms and URL steps still go to the guest who asked.
  - So the gate an owner already has (tools that need approval) still holds when a guest is prompting.
  - A later option, not v1: `share: {tools?: [...]}` on the definition, to narrow what a guest's turn may call.
- **Privacy.**
  - The membership check is per agent, so a member of one agent learns nothing about the owner's other agents or
    tenant.
  - The model never sees tenant ids.
  - Guests see the whole thread, including tool results, by design. The dialog says this too.
  - Signed file links last 15 minutes.

## Concurrency and supersede

- **One turn at a time.** With `queue: {mode: "batch"}`, a guest's burst of messages becomes one turn. Two people never
  share a turn (`joins`).
- **Capped members.** Each run carries `spendLimit = cap − spentToday` and so batches alone. That costs a capped member
  their batching. A new `memberLimit` that `batchable` ignores is a possible follow-up.
- **Admission.** A capped member at their limit gets 402 `member_daily_cap`, with the reset time (00:00 UTC).
- **Supersede.** A new prompt from anyone supersedes pending blocking inputs (`src/client-sessions.ts:2251`, Workers
  `agent-admission.ts:509-510`). So Bob's message cancels the question the agent asked Dana.
  - v1 keeps this, so the agent is never stuck behind one person.
  - The thread shows "Question withdrawn: Bob wrote while it waited".
  - Shared agents that wait for long should use `request_decision` (inbox slice 7), which prompts do not supersede.
  - See the open questions.

## Console UI

| Where | What |
| --- | --- |
| `/console/join` | New. Signed out: "Dana shared *camelCode lead: web* with you. Sign in to join", then the sign-in methods. Signed in: joins and opens the agent. |
| `/console/shared/:id` | New. The shared chat, for guests and for owners. |
| Agent page header | "Share" button: the dialog. A member count badge. |
| Agents list | A "Shared with me" section under the workspace nav, listing joined agents. |
| `/console/inbox` | Inbox slice 10, plus guests' items, tagged with the owner's name. |

**Shared chat**
- It is built on `@camelai/run-react`'s `<AgentChat>` primitives (messages, composer, tool and file parts), so the
  console gets streaming without writing a second renderer. The console's polling Conversation tab stays for unshared
  agents.
- Each user bubble is labelled with its sender's name. A role chip says "owner". Your own messages sit on the right.
  Channel senders get a small "via Slack" mark when `from.thread` is present.
- A status line above the composer: "Working on Dana's request · 2 queued (you, Bob)". Your queued messages show as
  "queued". Stop appears only when the turn is yours, or always for the owner.
- An input addressed to you shows inline, with an "Answer" button. Approvals show the guest "waiting for the owner".
- Presence is later. The member list in the header is enough for v1.
- Mobile: one column, the composer pinned to the bottom (`sticky bottom-0`, `pb-[env(safe-area-inset-bottom)]`), the
  status line collapsed to "Working · 2 queued", and members in a sheet. The console's existing `md:` breakpoints
  apply (`console/web/main.tsx:135-159`).

**The share dialog**
- "Create link": pick an expiry, then Copy.
- The list of live links, each with Revoke.
- The members table: name, email, joined, today's spend, a cap input ("No limit" by default), and Remove.
- One warning line: "People with access can ask this agent to do anything it can do without your approval, and see
  the whole conversation."

**Inbox page**
- The layout and keys follow inbox design feature 1b.
- Guests reach it from the console nav. For a guest with no agents of their own, the nav shows only Shared and Inbox.
- An item from a shared agent shows "from *agent* · shared by *owner*". Answering it posts with the member identity.

## Slices

Each slice is one PR. A slice that touches both backends adds a contract test under `tests/contract/areas/`.

| # | Slice | Depends on | Notes |
| --- | --- | --- | --- |
| S1 | Migration: the three tables and their indexes | none | |
| S2 | Owner API: links, members, caps, removal; the owner row; OpenAPI | S1 | both backends |
| S3 | `Sender.role`, the instruction line, owner stamping on console prompts | S1 | `src/sender.ts`, generated Workers copy, `system-prompt.ts`, `prompt-policy.ts` |
| S4 | Guest API: join, list, state, history, prompt, uploads, stop, leave; filtering; rate limits | S2, S3 | both backends |
| S5 | Streams: guest events route, `request_queued` and `request_started`, `from` on user frames, `endMember` and the 5-min recheck | S4 | both backends |
| S6 | Spend: `agent_member_days` in `settle`, the admission check, `spendLimit` per run | S1, S4 | `src/model-attempts.ts:235`, `spend.ts:428`, Workers `agent-billing.ts:103` |
| S7 | Approvals in guest turns go to the owner and approvers | S3 | `client-sessions/inputs.ts:81`, Workers `human.ts:110` |
| S8 | Console: join page, share dialog, members table | S2, S4 | |
| S9 | Console: shared chat page on run-react, mobile | S5, S8 | |
| S10 | Inbox: guests' items in `GET /v1/inbox`, answers and events | inbox slices 4, 5, 9; S4 | coordinate with the inbox work |
| S11 | Console inbox page with shared items | inbox slice 10, S10 | could be the same PR as inbox slice 10 |
| S12 | Docs: a guide section in `docs/frontend.md` and `concepts.md`, release note, `npm run docs` | S9 | |

**Parallel tracks**
- After S1: S2, S3 and S6 in parallel.
- After S4: S5, S7 and S8 in parallel.
- S10 and S11 track the inbox work.

**CTO steps:** none are required. To try it on the Workers pilot camelCode runs on, deploy as usual. Then create a link
on a camelCode lead and have a teammate join, by Google or by password, since mail is on.

## Open questions

1. **Supersede in a group.** Should a prompt supersede only the inputs of its own actor on shared agents? That keeps
   Dana's question alive while Bob talks. The catch is that the agent then waits on an ask that may hold a turn for
   hours. v1 says no.
2. **Guest API access.** Should guests be able to act through an API key of their own tenant, for example a CLI?
   v1 says no: console session only.
3. **Who answers approvals.** Is "owner + approvers" right for camelCode? There the approvers are Slack ids, and the
   owner may be a service account that no one signs in as.
4. **Watchers.** 32 viewers per agent. Raise it for shared agents, or rely on the poll fallback?
5. **Cancelling a queued prompt.** Should guests be able to cancel their own queued prompt? That needs a per-request
   cancel, which does not exist today.
6. **Email code sign-in.** It does not exist. Add it for guests, or keep Google, GitHub and password?
7. **The guest-tools allowlist** (`share.tools`): v1 or later?
