# Decision inbox and peer messaging: design

Status: proposal (2026-11-08), not built. Goal: one lead agent per area, a chief of staff over the leads, and one
prioritized queue where a person clears everything that waits on them, in batches, from the keyboard.

## Recommendation

1. **The inbox is the existing `agent_inputs` model, made tenant-wide.** Inputs gain priority, lineage, attachments
   and a recommendation. A new kind, the **non-blocking decision**, lets an agent ask and keep working. Inputs are
   indexed in Postgres on both backends, behind three endpoints: `GET /v1/inbox`, `POST /v1/inbox/answers` (one
   outcome per item) and `GET /v1/inbox/events` (SSE). A scoped **inbox token** lets a page act as one person.
2. **The web app is an `/inbox` page in the console.** People without a console login open it with an inbox token.
3. **Peers get explicit grants (`peers`) and use `send_message`.** A message arrives as an `<agent_message>` notice.
   It queues by default, may join a batch, and is bounded by a hop cap and the wake cap. Sub-agents stay private:
   they cannot be a peer or have one.

## What exists today

- **Node: a Postgres table, no paging.** Inputs are rows in `agent_inputs` (`migrations/016_agent_inputs.sql:3-22`).
  `GET /v1/inputs` (`src/api.ts:803-804`) lists at most 500, newest first, with no cursor (`src/inputs.ts:317-322`).
- **Workers: a fan-out.** Inputs live in a Pi doc per agent, at most 100 (`backends/workers/src/human.ts:27`, `:58-59`).
  `GET /v1/inputs` fetches from every agent's DO, up to 1,000 agents (`index.ts:338-347`, `control.ts:158`). That
  is one DO call per agent on every page load.
- **Answers are per agent, all or none** (`src/inputs.ts:339-351`; Workers `agent-http.ts:584-592`). The same answer
  twice gets 200. A different answer gets 409, saying how the input settled.
- **Blocking inputs do not survive an always-on lead.** Any prompt that is not a notice supersedes pending inputs
  (`src/client-sessions.ts:2251`, Workers `agent-admission.ts:509-510`), and the default expiry is 15 minutes. A lead
  that gets an event every few minutes loses its `ask_user` before anyone opens the inbox. That is why this design
  adds non-blocking decisions.
- **Who may answer:** the turn's actor and the definition's approvers (`mayAnswer`, `src/inputs.ts:167-174`).
- **Tokens:** API tokens have no scopes (`src/api-schemas.ts:890`). Browser tokens are read-only and bound to one
  agent (`src/api.ts:174`, `:335-345`).
- **Files:** `present_file` returns signed links (`docs/guides/files.md:117-120`), which last 15 minutes by default
  and 24 hours at most (`:223-236`).

## Feature 1: the inbox

**The item.** The `Input` schema (`src/api-schemas.ts:711-723`) gains these fields:

| Field | Meaning |
| --- | --- |
| `priority` | `urgent`, `high`, `normal` or `low`. Approvals default to `high`. |
| `blocking` | True for every input that exists today. |
| `agent` | The agent that asks. |
| `lineage` | The chain from the root agent to the one that asks, at most 5 deep. |
| `subject` | Who the agent acts for. |
| `attachments` | `{path, version, contentType, caption, url}` for each file. |
| `links` | https links only. |
| `recommendation` | `{answer, reason}` |
| `key` | Lets a later request replace this item. |
| `version` | Increases on every change. |

**Asking.**
- `ask_user` (`src/builtins.ts:134-147`, `src/inputs.ts:105-124`, Workers `human.ts:203`) gains `priority`,
  `attachments`, `links`, and a `recommended` option with a `reason` for each question.
- A new builtin, **`request_decision`**, takes the same fields plus `title`, `body`, `options?` and `key?`. Its
  expiry defaults to 7 days. It returns `{inputId}` at once and never suspends the turn, and a new prompt does not
  supersede it.
- A second request with the same `key` (for example `pr-123` after a new push) marks the old item `withdrawn`.
- The answer reaches the agent as a runtime notice, `decision_<hash>`:
  `<decision_answer id by>…</decision_answer>`. All the answers one POST gives to one agent travel in one notice, so a
  person who clears 20 items of one lead costs that lead one turn, not 20. Expiry sends an `expired` notice.
- Decisions are stored only in Postgres, on both backends: no Pi task waits on them.

**Attachments.** The runtime checks each path when the item is made: the file must exist in the agent's mounts, and
an item takes at most 32. It stores `{path, version}`. Each list response signs a fresh 15-minute GET link, using the
same signer as `POST /v1/agents/:id/links`. Screenshots (from the browser tool or `generate_image`) and recordings (an
mp4 a computer wrote to the workspace) are ordinary files. No new file primitive is needed.

**Where the index lives**
- **Node:** `agent_inputs` already is the source of truth. One migration adds `priority`, `blocking`, `subject`,
  `responders text[]`, `root_agent`, `lineage` (its depth is bounded by delegation's depth limit, not by its own check), `item_key`, `version` and `updated_at`. `responders` is the audience
  plus the definition's approvers, frozen when the input is made. Two indexes back it: a partial index on
  `(tenant, priority_rank, expires_at, id) where state='pending'` (`priority_rank` is a smallint, urgent 0 to low 3, because the text `priority` sorts alphabetically), and a GIN index on `responders`. `Inputs.create` and
  `settle` (`src/inputs.ts:270-335`) fill the columns and call `pg_notify('inbox', tenant)` in the same transaction,
  as `src/webhooks.ts:192` does.
- **Workers:** the Pi doc stays the authority for blocking inputs. The agent's DO keeps a **mirror row** in the same
  Postgres table. It stages the row in the transaction that already stages the input webhook (`agent-transport.ts:33`,
  `agent-turn-loop.ts:849-850`, expiry and supersede at `:888-901`). `AgentWebhooks.flush` (`run-webhooks.ts:61-92`)
  then upserts the row only when its `version` is newer, so replays are harmless. This removes the fan-out at
  `index.ts:338-347`.
- **Staying consistent:** answers always go to the authority, either the DO or the row's compare-and-set
  (`src/inputs.ts:328-335`). If the mirror is stale, the person gets a 409 that says how the input settled, and the
  same 409 repairs the row. The list hides pending rows past `expires_at`, so an input that expired on its own never
  shows. A sweep re-reads rows pending for more than an hour, 100 a minute.
- **Cost at 10k pending items:**
  - Storage: about 3 KB a row, so about 30 MB.
  - A 50-item page: one index range scan, a few milliseconds.
  - Counts per lead: one `group by` over the rows.
  - Writes on Workers: one more upsert inside a flush that already happens.
  - Today a Workers page load makes one DO call per agent.

**Endpoints**
- **`GET /v1/inbox?for=&subject=&root=&priority=&kind=&cursor=&limit≤100`** lists pending items. Order: priority,
  then the soonest auto-answer, then age. It also returns `counts` by priority and by lead. `for=<actor>` keeps the
  items whose `responders` include that actor, and the open items of subjects the caller may see.
- **`POST /v1/inbox/answers {answers: [{id, action, content?} | {id, accept: "recommended"}] ≤100}`** returns one
  outcome per item: `answered` (202), `same` (200), `conflict` (409, with `state` and `by`), `forbidden` or `unknown`.
  - The runtime groups answers by agent and calls the existing per-agent path (`src/client-sessions/inputs.ts:123`,
    Workers `agent-http.ts:584`).
  - When a group gets a 409, it retries that group's items one at a time, so each item gets its own outcome.
  - `accept: "recommended"` applies the recommendation stored when the item was made, never one that changed after
    the person read it.
  - Answering a sub-agent's input keeps working, as it does today (`docs/guides/multi-agent.md:96-97`).
- **`GET /v1/inbox/events`** is an SSE stream of `item {id, version, state}` frames. After a reconnect the client
  re-fetches the list.
  - Node: one `LISTEN` per node, fanned out to that node's watchers.
  - Workers: the tenant DO holds inbox watchers, as it holds event watchers today (`tenant-watchers.ts`). Agent DOs
    ping it after each flush; they already call it (`agent-turn-loop.ts:304`).

**Who may see and answer**
- An API token or a console session sees everything.
- An **inbox token** (`POST /v1/inbox-tokens {actor, subjects?, roots?, expiresIn ≤30d}`, minted by your server)
  reaches only `/v1/inbox*` and its signed links.
- An answer sent with an inbox token is recorded as `by.actor`, and the caller cannot change who it names.
- `mayAnswer` still applies to every answer.
- The guard is the browser-token guard with its own routes.
- The model can never answer an input.

## Feature 1b: the web app

The app is **`console/web/pages/inbox.tsx`, served at `/inbox`.** Console users are signed in already. Everyone else
opens `/inbox#token=…`: the fragment keeps the token out of logs, and the token carries the API origin, as browser
tokens carry `url` (`src/api.ts:116`).

A static example page would make each adopter set up CORS (`tenant_cors_origins`), host the page, and rebuild the
keyboard flow. The console already has auth and a design system (`console/DESIGN.md`), and it ships with every
release. An app that wants its own UI uses the same endpoints.

Keyboard:

| Key | Action |
| --- | --- |
| `j` / `k` | next / previous item |
| `enter` | expand it, showing attachments inline |
| `o` | open the PR |
| `1`–`4` | pick an option |
| `a` | accept the recommendation |
| `y` / `n` | approve / decline |
| `r` | answer in your own words |
| `x` | select; `shift+a` accepts the recommendation for every selected item |
| `/` | filter by lead |
| `u` | undo |

Answers wait 5 seconds (the undo window), then go in batches of up to 100. An item that conflicts shows how it settled.

## Feature 2: peer messaging

**Options**
- **(a) Explicit grants (recommended).** The tenant decides who may talk to whom. It reuses `send_message`, the notice
  path, the wake cap, and the `<agent_message>` rendering (`src/sender.ts:81`).
- **(b) Topics.** One publish starts N subscriber turns, so loops multiply, and topics need subscription state and an
  ordering model. Defer: a topic can later be a grant to many agents.
- **(c) The API, as an outside actor.** This works today, since leads are named agents. What breaks:
  - It **supersedes the recipient's pending inputs** (`agent-admission.ts:509-510`).
  - There is no wake cap.
  - The message looks like it came from a person.
  - It batches under the app's actor.
  - The agent's tool server needs a tenant API key.
- **(d) `spawn_agent({agent: "<lead>"})`.** It is scoped to one task. The lead's turn draws on the chief of staff's
  spend share (`multi-agent.md:193`), and the lead can only reply to "parent" during that run
  (`src/client-sessions/children.ts:683-690`).

**Recommended spec**
- **Addressing.** An agent or definition takes `peers: [{agent | definition, name?, interrupt?}]`, at most 32.
  - A `definition` entry matches every agent made from that definition that is not a sub-agent.
  - `send_message({to})` resolves `to` in this order: "parent", then the agent's own sub-agents
    (`children.ts:692`), then its peers.
  - `spawn_agent` refuses a name that a peer already has.
- **Authorization.**
  - A grant goes one way. A reply needs the reverse grant.
  - A target that is a runtime-made sub-agent is refused with `SUBAGENT_VIA_PARENT`, both in the config and at send
    (`src/scheduler.ts:102` and Workers `agent-lifecycle.ts:72` show how to detect one).
  - A sub-agent cannot have `peers`, and its `send_message` never resolves its parent's peers.
- **Delivery.**
  - The request id is `peer_<hash(sender, run, call)>`, so a retry sends nothing twice, as `msg_` ids do
    (`delegation.ts:502`).
  - The message carries a notice `{source, root, hops, metadata: {kind: "message", to: "peer"}}`, signed like
    `delegationSignature`.
  - `validNotice` and the steerable check (`src/client-sessions.ts:1771-1772`) accept `to: "peer"`.
  - By default the message queues as a follow-up.
  - `urgent: true` steers the running turn instead, and only when the grant has `interrupt`, as a chief of staff's
    grant to a lead would.
  - It is a notice, so it never supersedes the recipient's inputs.
  - The recipient reads `<agent_message name="chief-of-staff">`.
- **Batching (#746).** `batchable` (`shared/queue-mode.ts:34-39`) admits notices with `to: "peer"`. `peer_` stays out
  of `RUNTIME_IDS` (`:26`). `joins` (`:46-48`) is unchanged: a peer turn has no actor, so it joins other peer
  messages and app prompts without an actor. On Workers, `batch-queue.ts` holds peer messages as it holds other
  prompts.
- **Loops.**
  - A turn started by a peer message passes that message's `root` on, so a ping-pong spends one wake-cap bucket
    (100 an hour; Node `children.ts:845`, Workers `agent-admission.ts:458-463`).
  - Each peer-started turn adds one to `hops`. After 6, a message lands without a turn (`stopped:
    "peer_hop_limit"`).
  - The limit of 20 messages per turn still holds (`src/multi-agent.ts:31`).
- **Billing.** A peer-started turn is the recipient's: its limits, key scope, subject and bucket. Nothing is charged
  to the sender. Usage records `trigger: "peer_message"` and the sender.
- **Replies.** A reply is another `send_message`, with `inReplyTo` optional. Peers have no `wait_agent`.
- **Observability.**
  - Stream events: `peer_message` on the recipient's stream and `peer_message_sent` on the sender's.
  - `GET /v1/agents/:id/peers` lists the grants and when each was last used.
  - A `peer_message` metric line records `{tenant, from, to, into | refused}`.
- **Unchanged from #740.**
  - A sub-agent is still reached only through its parent (`src/multi-agent.ts:88-90`, `src/client-sessions.ts:1775`,
    `agent-admission.ts:213-221`).
  - A grant to a lead reaches none of the lead's sub-agents.
  - Sub-agents never batch.

## Decisions (CTO, 2026-11-08)

1. **Expiry:** an item may apply its recommendation as the answer when it expires, if the asking agent opts in on that item. Approvals never do.
2. **Always-on agents** use the new non-blocking `request_decision`, which new prompts never cancel. `ask_user` keeps its in-turn semantics.
3. **Peer billing:** a peer message's turn bills the recipient's bucket.
4. **Apps post items directly** with `POST /v1/inbox/items`. Answers go back to the app by webhook. This adds a slice.
5. **No Slack digest in v1.**

## Implementation slices

Each slice is one PR. A slice that touches both backends adds a contract test (`tests/contract/areas/`).

| # | Slice | Anchor |
| --- | --- | --- |
| 1 | Migration: the new columns, the `withdrawn` state, the indexes | Where the index lives |
| 2 | Node: `Inputs.create` and `settle` fill the columns and call `pg_notify` | `src/inputs.ts:270-335` |
| 3 | Workers: stage the mirror row, upsert by `version`, repair on 409, sweep | `run-webhooks.ts:61-92` |
| 4 | `GET /v1/inbox` on both backends; `/v1/inputs` delegates to it | Endpoints |
| 5 | `POST /v1/inbox/answers` | Endpoints |
| 6 | New `ask_user` fields | `src/builtins.ts:134-147` |
| 7 | `request_decision` | Asking |
| 8 | Inbox tokens | Who may see |
| 9 | SSE on Node and Workers | Endpoints |
| 10 | The console `/inbox` page | Feature 1b |
| 11 | The `peers` config and its validation | Addressing, authorization |
| 12 | `send_message` to peers | Delivery |
| 13 | Admission: hop cap, wake root, `batchable` | Delivery, batching |
| 14 | Events, usage, `GET /v1/agents/:id/peers`, docs | Observability |
| 15 | `POST /v1/inbox/items` for apps, with answer webhooks | Decision 4 |
