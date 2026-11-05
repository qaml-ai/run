# Hybrid table and transaction audit

Audited against source commit `7d991fe266766ad978b272a445ca02bbbbeb63e9`.
`migrations/` creates **116 distinct tables**, drops **7**, and leaves **109**.
The proposed split is **12 agent DO tables, 96 Postgres tables, 8 deleted**.
Only **one of those eight deletions is new and conditional** (`memory_retirement_guard`): remove it only after all residual ECS hosts stop using memory retirement. Until then it remains in the deployed PG schema; it is absent from the new DO agent path.
The other seven were already removed by existing migrations and are not savings.
`schema_migrations` is created by `src/db.ts`, outside `migrations/`; retain it
in Postgres, and give each DO an independent local schema version.

This intentionally conservative target moves agent execution and its hot state,
not every row containing an `agent` column. It keeps the existing shared-volume,
voice and external computer services during the hybrid rollout. Thus
`runtime_nodes`, `actor_owners`, `log_records`, GC and pins remain for those
services and for old agents until migration completes. They cease to be a
requirement of **new agent execution**. Moving shared volumes to their own DOs
would be another port, with separate concurrency, metadata and GC work.
Cloudflare does not provide the application's cross-agent quotas, shared file
reachability, invoice reconciliation or external provider session recovery.

The `agents` row remains the authoritative directory: tenant, public id,
backend/locator, generation, revocation/tombstone and administrative projection.
Its mutable execution header, cursors, request state and recovery markers move
into the DO. The table therefore shrinks substantially without disappearing.
`busy_agents` remains a **tenant admission** table, with expiring
reservation/generation fields instead of node/session ownership. Removing that
table without replacing its semantics would permit unlimited parallel paid work.

## Method and limits

[hybrid-table-map.json](hybrid-table-map.json) records creation/drop migrations,
selected source evidence with line numbers, all lexical `src/**/*.ts` references,
classification and boundary tags for each table. The selected evidence and
related callers were read, including transaction wrappers and commit hooks;
lexical references alone are not proof that a module issues SQL (words such as
`agents` and `usage` also appear as ordinary names). The inventory script strips
SQL comments and checks every created name, later drop and selected source line:

```sh
node backends/cloudflare/studies/check-table-map.mjs
node backends/cloudflare/studies/check-table-map.mjs backends/cloudflare/docs/hybrid-hyperdrive-results.json
```

The second command also checks the actual local PostgreSQL catalog after the
Hyperdrive spike applied all 112 migrations: all 109 live names match exactly
(plus the runner's `schema_migrations`). No production query was made.
The ownership and transaction decisions remain a static code audit.
Dynamic Pi SQL uses a table-name mapping in
`src/pi-durable/storage.ts`, so its eight tables must be followed through that
adapter rather than searched only for literal INSERT statements. A future
migration must also inventory object-storage logs/blobs, not merely SQL tables.

## Boundary tags

`USAGE`, `INPUT` and `PURGE` contain observed **mixed-class writes in one current
transaction**. `FENCE` is a current cross-class locking dependency, not a claim
that ownership rows are changed in every journal transaction. `CHILD`, `REGISTRY`,
`CHANNEL`, `FILES`, `SCHEDULE` and `ADMISSION` include object boundaries or
already-separate operations; they are listed separately to avoid inventing
atomicity that the current code does not have. A tag on a table identifies its
participation in that family; it does not imply every member is written by every
transaction in the family.

### Observed atomic write seams

| Seam | Current code and atomicity | Hybrid protocol and crash behavior |
| --- | --- | --- |
| `USAGE`: journal to financial receipt | `src/pi-durable/storage.ts` calls `commitEffects` inside its Pi batch transaction; `nativeUsageEffect` in `src/client-sessions/spend.ts` inserts `pi_usage_receipts` and increments `agent_spend_limits`. The host journal's `log_records` append can invoke the same spend effects through `src/log-tail.ts`. Entries carrying `usage.billingAttemptId` only update agent spend here; their account charge comes from `model_attempts`, not a second receipt. The receipt consumer in `src/accounts.ts` locks unaccounted receipts and updates `usage`, `workspace_usage`, `usage_flushes`, `credit_ledger`/`credit_accounts`, `credit_spend_minutes` and webhook outboxes in one PG transaction. | Commit the canonical model entry, local agent spend and a **new DO outbox record** in one SQLite transaction. Stable identity is `(public_agent_id, backend_generation, entry_id, accounting_kind)` with payload hash and an explicit immutable usage revision. Deliver through Hyperdrive to a PG inbox/dedupe key, then run the existing financial updates and mark accounted **in that one PG transaction**. ACK only after PG commit; delete/mark the DO outbox after ACK. Lost ACK retries the identical key and hash, never adds a second charge. Keep the existing `pi_usage_receipts` table as the PG inbox, with a generation-aware unique key for imported agents. Tracked attempt events must settle only through `model_attempts`; untracked usage uses the receipt inbox. Preserve this mutually exclusive charge path so the same model response is not billed by both consumers. Never read eventual account totals to decide whether to start an unreserved paid call. |
| `INPUT`: human/tool request and webhooks | `src/inputs.ts` creates `agent_inputs` and calls `enqueueEvents` inside `underClaim`; `settle` updates the answer with a CAS and enqueues `input.resolved` in the same transaction. Multiple input answers can settle atomically in one batch. | Put pending inputs, immutable answer CAS, wake marker and event outbox in one DO transaction. Deliver webhook/inbox projection by stable input/event id and generation; PG inserts `webhook_deliveries` idempotently. A PG projection may lag, but cannot authorize or override a DO answer. Answer routes resolve directory → DO and compare expected input revision; a repeated same answer succeeds and a different answer conflicts. The tenant-wide inbox is a new PG projection, not an unbounded scatter-gather across DOs. |
| `PURGE`: private history and retained shared state | `src/client-sessions.ts` `purge` runs `purgeData`/Pi deletion, `agent_children`, `schedules`, `agent_inputs`, `agent_spend_limits`, `chunk_pins`, `volume_watchers`, email/channel references and the `agents` tombstone in one fenced PG transaction. `discard` likewise deletes the directory and private data together. Object-storage deletes already occur outside SQL's rollback guarantees. `src/account-deletion.ts` finally deletes both DO-bound and PG-bound tenant rows in one SQL cleanup transaction. | First commit PG revocation plus incremented generation and a purge outbox; requests and new reservations fail immediately. Send generation-fenced purge to the DO, stop/abort work, flush already-incurred usage receipts, delete private state and R2 objects according to retention, and return an idempotent purge receipt. In a final PG transaction delete shared pointers/pins and mark the directory/account deletion complete. **Release pins only after private references cannot be read again.** Failed purge remains visible/retryable; never report physical erasure from the initial revocation. Persist a minimal tombstone at both authorities to reject delayed messages; older-generation receipts need a defined billing-only reconciliation path. |

### Other boundaries that must be implemented

| Boundary | Current evidence | Concrete hybrid design |
| --- | --- | --- |
| `FENCE`: journal/inputs/schedules vs ownership | `src/pi-durable/storage.ts` locks `actor_owners FOR SHARE` before metadata; `src/inputs.ts`, `src/scheduler.ts`, `src/client-sessions.ts` and volume writes use `underClaim`. PG ownership plus `runtime_nodes` prevents stale ECS writers. These are locking dependencies even where the only modified table moves to the DO. | A new agent DO uses platform single-object execution plus local transaction ordering; do not call PG ownership for every entry. Every external PG mutation carries the directory backend generation and is rejected if revoked/stale. Existing-agent cutover first freezes/fences the ECS actor and exports at a stable commit cursor; verify import, then CAS the PG directory generation/backend. Never permit simultaneous ECS and DO effects. Shared-volume actors retain existing ownership until their own explicit port. |
| `USAGE`: reserve/dispatch/settle | `src/credit-holds.ts` reserves under `credit_accounts FOR UPDATE`; `src/model-attempts.ts` starts end-user and tenant holds before dispatch and settles attempts, holds, both ledgers, daily/workspace totals and webhook events in PG. The initial end-user hold, tenant hold and attempt insertion are **separate** transactions today; the final settlement is one PG transaction. | Commit a DO attempt intent, then use one Hyperdrive PG transaction to validate identity/generation, lock account/end-user rows in fixed order, create idempotent tenant/end-user holds and the durable attempt. Dispatch only after that commit. Persist provider completion plus settlement outbox locally; settle in one PG transaction, deleting holds and posting revisioned deltas. Crash after reservation but before dispatch releases through reconciliation/expiry; crash after dispatch is **uncertain**, never automatically refunded or redispatched on timeout. Extend/renew by idempotent operation id while streaming; fail closed before the reserved budget/expiry is exhausted. An expired hold alone is not evidence that a provider did no work. |
| `ADMISSION`: account-wide busy slots | `src/busy-agents.ts` holds a tenant advisory transaction lock, evaluates paid tier, counts live `runtime_nodes`-backed rows and inserts `busy_agents`. A DO only serializes its own agent, not sibling agents. | Keep PG admission under the tenant lock, using stable reservation id + backend generation, expiry and conditional renew/release. Renew before accepting more paid work; after lost renewal stop dispatch and reconcile outstanding work. Old ECS heartbeat rows and new DO reservations both count during rollout. Expiry must be longer than the bounded unrenewed dispatch period; a recovered old reservation is reconciled rather than treated as a free extra slot. |
| `CHILD`: parent ↔ child ↔ root | `src/client-sessions/children.ts` stores child handles before sending prompts, records end/resume rows together, and increments the parent's `agent_spend_limits` with a late completion in one transaction. Both move to the **parent** DO. Root-hour `agent_wakes` is a separate PG counter, not in that transaction. | Parent commits child intent + reserved child budget + send outbox locally. Child accepts `(parent_id, spawn_id)` once and stores the validated parent reply address/lineage durably; replies carry immutable completion id/cost/revision. Parent records completion, marks notification and releases/debits budget in one local transaction. Stable `child_<request_id>` delivery stays idempotent. Root-wide wake admission remains a PG atomic increment keyed by root/hour and a dedupe token so a retransmission cannot consume twice. Child's local journal and parent's journal never share a transaction. |
| `REGISTRY`: agent creation/configuration vs directory | `src/client-sessions.ts` creates `agents` and inherited `computer_connections` in one PG transaction. Configuration/mount/workspace writes are not one all-enclosing transaction today. | PG directory create + inherited connection snapshot + provisioning outbox commit together. Initial DO create is idempotent by public id/generation/config hash; directory becomes ready only after ACK. Later configuration commands carry monotonically increasing version and immutable payload hash; DO accepts in order and emits an applied projection. Revoke at PG first; strict authorization uses PG generation, not stale projection. User-facing mutable settings need one named authority, not last-writer-wins copies. |
| `CHANNEL`: provider inbox/outbox vs agent turn | `src/channels.ts` commits provider dedupe/counters/outbox and channel mappings in PG; delivery to an agent and outgoing provider calls are already outside that transaction. Email metadata and managed Discord setup also mutate these PG tables. | Keep provider ingestion transaction and durable `channel_items`; send a stable provider-message id as the DO request id and ACK after the DO journal accepts it. DO completion outbox updates the PG channel item once, then existing sender retries provider delivery using provider-supported idempotency. Uncertain non-idempotent external sends need reconciliation, not an exactly-once claim. |
| `SCHEDULE`: wake vs report email | `src/scheduler.ts` writes schedule state under an ownership lock; dispatch, `schedule_deliveries` insertion and next-due/delete updates are separate operations today. | DO alarm multiplexes earliest due schedule, input expiry, outbox retry and lifecycle wake. One local transaction creates stable `(schedule_id, scheduled_due_at)` request + optional delivery outbox and advances next due. PG delivery insertion dedupes that key, then mail worker runs normally. Alarm retry cannot double-submit; cancellation/revision checks happen at local commit. Preserve timezone/DST/calendar semantics and catch-up policy. |
| `FILES`: local history vs shared file graph | `src/volumes.ts` publishes immutable blobs, tracks `chunk_touches`, `chunk_pins`, `volume_snapshots` and `volume_watchers`; `src/storage-gc.ts` checks reachable roots and grace periods. File/pin publication and journal insertion are not one transaction everywhere today. | Keep shared metadata/GC in PG and bulk bytes in object storage/R2. Pin an immutable hash with idempotent `(agent,generation,entry,hash)` **before** publishing its DO reference; if local commit fails, leave the extra pin for a conservative sweeper. Release through a DO outbox only after the reference is deleted. Check content hash on reads and preserve fork/snapshot pins. R2 lifecycle rules can expire known temporary prefixes, but cannot infer live references or replace general GC. Shared writes need volume authority/version CAS and durable watcher delivery. |

**No session-pooling shortcut.** `src/log-tail.ts` holds a session-level advisory
lock across blob compaction; `src/computers/service.ts` holds one across provider
operations; `src/db.ts` uses a dedicated LISTEN connection and migration advisory
locks. These implementations are not portable unchanged to a transaction-pooled
Hyperdrive connection. Keep those adapters on their existing control-plane
service initially, or replace long session locks with short transactional
reservation/version state machines. `pg_advisory_xact_lock` inside an explicit
transaction is a different mechanism. Do not hold a PG transaction open across
an entire model generation, R2 stream or external computer API call.

## Complete migration-created table map

`Agent DO` means the conceptual record moves to SQLite, not that the existing
Postgres DDL runs unchanged there. PG is Postgres. Source links name the selected
consumer; JSON records all literal references. `Already dropped` rows are kept
in the audit because they occur in migration history.

| Table | Destination | Reason and selected source | Boundaries |
| --- | --- | --- | --- |
| `runtime_nodes` | Postgres | Retain for shared-volume and legacy host leases during coexistence; agent DO routing no longer writes it. [src/ownership.ts](../../../src/ownership.ts#L184) | FENCE |
| `actor_owners` | Postgres | Retain volume ownership and migration fencing; DO agents replace their actor rows, not the shared-volume authority. [src/ownership.ts](../../../src/ownership.ts#L32) | FENCE |
| `tenants` | Postgres | Identity, signup eligibility and billing mode stay with relational account authority. [src/accounts.ts](../../../src/accounts.ts#L5) | — |
| `provider_keys` | Postgres | Encrypted tenant provider credentials and account deletion stay centrally scoped. [src/accounts.ts](../../../src/accounts.ts#L18) | — |
| `api_tokens` | Postgres | Tenant token lookup, revocation and listing require one account authority. [src/accounts.ts](../../../src/accounts.ts#L18) | — |
| `usage` | Postgres | Tenant/day/model financial totals commit with ledger and delivery records. [src/accounts.ts](../../../src/accounts.ts#L16) | USAGE |
| `agents` | Postgres | Keep tenant directory, authorization, tombstones and backend generation; move hot header/runtime fields into the agent DO. [src/client-sessions.ts](../../../src/client-sessions.ts#L142) | REGISTRY, PURGE, FENCE |
| `schedules` | Agent DO | Per-agent schedule definitions and next due time fit local SQLite plus a multiplexed alarm; calendar/retry logic remains. [src/scheduler.ts](../../../src/scheduler.ts#L11) | FENCE, SCHEDULE, PURGE |
| `channels` | Postgres | Tenant integration configuration and credentials are shared by many agents. [src/channels.ts](../../../src/channels.ts#L29) | — |
| `channel_conversations` | Postgres | Provider conversation-to-agent identity must remain unique across Workers. [src/channels.ts](../../../src/channels.ts#L30) | CHANNEL, PURGE |
| `channel_agents` | Postgres | Reverse channel binding and access filters belong with provider conversation identity. [src/channels.ts](../../../src/channels.ts#L31) | CHANNEL, PURGE |
| `channel_items` | Postgres | Inbound/outbound delivery outbox must survive retries and coordinate shared provider rate limits. [src/channels.ts](../../../src/channels.ts#L32) | CHANNEL |
| `channel_seen` | Postgres | Provider message deduplication commits with durable inbound delivery. [src/channels.ts](../../../src/channels.ts#L33) | CHANNEL |
| `channel_counts` | Postgres | Channel-wide rate counters must cover all agent objects. [src/channels.ts](../../../src/channels.ts#L34) | CHANNEL |
| `volumes` | Postgres | Shared-volume identity, tenant access, tombstones and retention remain relational. [src/volumes.ts](../../../src/volumes.ts#L18) | PURGE, FENCE |
| `volume_snapshots` | Postgres | Shared snapshot metadata and pin policy are not supplied by R2. [src/volumes.ts](../../../src/volumes.ts#L19) | FILES |
| `volume_watchers` | Postgres | Shared volume-to-agent subscriptions span objects and require delivery reconciliation. [src/volumes.ts](../../../src/volumes.ts#L19) | FILES, PURGE, FENCE |
| `log_records` | Postgres | Retain shared-volume hot log tails; agent host journals move to SQLite and shrink this mixed table. [src/log-tail.ts](../../../src/log-tail.ts#L9) | USAGE, PURGE, FENCE |
| `definitions` | Postgres | Reusable tenant definitions, revisions and list/filter behavior span agents. [src/definitions.ts](../../../src/definitions.ts#L22) | — |
| `credit_ledger` | Postgres | Append-only money movements and anti-duplication keys remain atomic with account balance. [src/billing.ts](../../../src/billing.ts#L20) | USAGE |
| `credit_accounts` | Postgres | Locked balance and paid-credit totals are the tenant spending authority. [src/billing.ts](../../../src/billing.ts#L22) | USAGE |
| `usage_flushes` | Postgres | Batch deduplication commits together with usage, ledger, workspace and webhooks. [src/accounts.ts](../../../src/accounts.ts#L40) | USAGE |
| `billing_jobs` | Postgres | Durable billing/storage accrual jobs are account-wide financial work. [src/billing.ts](../../../src/billing.ts#L745) | — |
| `signing_keys` | Postgres | Persistent signing-key rotation and credential verification belong to control plane. [src/identity.ts](../../../src/identity.ts#L94) | — |
| `credit_spend_minutes` | Postgres | Per-tenant hourly credit allowance must remain in the money transaction. [src/billing.ts](../../../src/billing.ts#L98) | USAGE |
| `storage_usage` | Postgres | Account/volume storage totals drive billing and need reconciliation with retained objects. [src/storage-usage.ts](../../../src/storage-usage.ts#L27) | — |
| `agent_inputs` | Agent DO | Pending human/tool input, answers and expiry belong beside the paused journal; tenant inbox needs a PG projection. [src/inputs.ts](../../../src/inputs.ts#L15) | INPUT, FENCE, PURGE |
| `key_scope_providers` | Postgres | Provider access scopes are tenant policy shared across agents. [src/key-scopes.ts](../../../src/key-scopes.ts#L109) | — |
| `agent_spend_limits` | Agent DO | Per-agent limit, reset epoch and spent amount commit with its journal; this is not the tenant credit ledger. [src/client-sessions.ts](../../../src/client-sessions.ts#L1099) | USAGE, CHILD, PURGE |
| `usage_webhooks` | Postgres | Legacy tenant usage endpoint configuration stays at financial delivery authority. [src/webhooks.ts](../../../src/webhooks.ts#L80) | USAGE |
| `usage_webhook_outbox` | Postgres | Legacy usage deliveries are committed with financial totals and retry independently. [src/webhooks.ts](../../../src/webhooks.ts#L78) | USAGE |
| `agent_history_chunks (already dropped)` | Delete | Already dropped by 095_drop_history_index.sql; no current src consumer. This is not a new hybrid saving. [migrations/095_drop_history_index.sql](../../../migrations/095_drop_history_index.sql#L1) | — |
| `agent_history_index (already dropped)` | Delete | Already dropped by 095_drop_history_index.sql; no current src consumer. This is not a new hybrid saving. [migrations/095_drop_history_index.sql](../../../migrations/095_drop_history_index.sql#L1) | — |
| `tenant_cors_origins (already dropped)` | Delete | Already dropped by 023_drop_tenant_cors_origins.sql; no current src consumer. This is not a new hybrid saving. [migrations/023_drop_tenant_cors_origins.sql](../../../migrations/023_drop_tenant_cors_origins.sql#L2) | — |
| `webhook_endpoints` | Postgres | Tenant subscriptions and encrypted signing secrets are shared configuration. [src/webhooks.ts](../../../src/webhooks.ts#L74) | USAGE, INPUT, CHANNEL |
| `webhook_deliveries` | Postgres | Durable globally deduplicated webhooks and retry state stay at delivery authority. [src/webhooks.ts](../../../src/webhooks.ts#L72) | USAGE, INPUT, CHANNEL |
| `idempotency_keys` | Postgres | API-wide request deduplication spans account/control-plane operations. [src/idempotency.ts](../../../src/idempotency.ts#L32) | — |
| `chunk_touches` | Postgres | Shared immutable chunk last-use tracking prevents R2 garbage collection racing publication. [src/volumes.ts](../../../src/volumes.ts#L838) | FILES |
| `chunk_pins` | Postgres | Transcript FileRefs can outlive mutable volume entries; R2 has no cross-object reference counting. [src/volumes.ts](../../../src/volumes.ts#L852) | FILES, PURGE |
| `gc_candidates` | Postgres | Two-pass grace-period candidates remain needed for shared R2 chunk deletion. [src/storage-gc.ts](../../../src/storage-gc.ts#L49) | FILES |
| `storage_gc` | Postgres | Tenant GC coordination remains while a shared-volume service owns chunk reachability. [src/storage-gc.ts](../../../src/storage-gc.ts#L95) | FILES |
| `model_providers` | Postgres | Tenant custom model endpoints and encrypted credentials must be centrally managed. [src/model-providers.ts](../../../src/model-providers.ts#L143) | — |
| `email_threads` | Postgres | Email threading headers and sender identities are provider conversation metadata. [src/channels-email.ts](../../../src/channels-email.ts#L24) | CHANNEL, PURGE |
| `email_messages` | Postgres | Provider Message-ID deduplication and references stay with shared email delivery. [src/channels-email.ts](../../../src/channels-email.ts#L25) | CHANNEL, PURGE |
| `oauth_grants` | Postgres | OAuth clients/scopes and grant revocation are account authority. [src/oauth.ts](../../../src/oauth.ts#L130) | — |
| `oauth_tokens` | Postgres | Refresh/access token lifecycle must preserve atomic rotation and revocation. [src/oauth.ts](../../../src/oauth.ts#L130) | — |
| `starting_credit_decisions` | Postgres | Immutable identity eligibility decisions prevent repeated free credit after deletion. [src/billing.ts](../../../src/billing.ts#L417) | — |
| `billing_alert_settings` | Postgres | Account threshold settings stay with balance and notification policy. [src/billing-alerts.ts](../../../src/billing-alerts.ts#L57) | — |
| `billing_recipients` | Postgres | Verified billing recipients authorize financial and scheduled emails. [src/billing-alerts.ts](../../../src/billing-alerts.ts#L58) | — |
| `billing_email_suppressions` | Postgres | Email-level suppression spans tenants and must remain durable. [src/billing-alerts.ts](../../../src/billing-alerts.ts#L59) | — |
| `billing_confirmation_limits` | Postgres | Confirmation rate limits coordinate tenant/email recipient verification. [src/billing-alerts.ts](../../../src/billing-alerts.ts#L230) | — |
| `billing_events` | Postgres | Only deletion cleanup references it today; retain compatibility until a separate dead-schema audit proves safe removal. [src/account-deletion.ts](../../../src/account-deletion.ts#L54) | — |
| `billing_email_outbox` | Postgres | Durable financial email queue and idempotency stay with billing policy. [src/billing-mailer.ts](../../../src/billing-mailer.ts#L102) | — |
| `billing_stripe_refunds` | Postgres | Stripe refund deduplication and ledger correction stay one money transaction. [src/billing.ts](../../../src/billing.ts#L685) | — |
| `billing_stripe_customers` | Postgres | Stripe customer identity is tenant-level payment state. [src/billing-payments.ts](../../../src/billing-payments.ts#L42) | — |
| `billing_checkouts` | Postgres | Checkout eligibility, completion and deduplication stay with ledger settlement. [src/billing-payments.ts](../../../src/billing-payments.ts#L84) | — |
| `billing_checkout_cutover` | Postgres | Legacy checkout cutoff is shared payment migration state, not agent state. [src/billing-payments.ts](../../../src/billing-payments.ts#L125) | — |
| `billing_auto_settings` | Postgres | Automatic funding thresholds and Stripe payment settings remain relational. [src/auto-topup.ts](../../../src/auto-topup.ts#L34) | — |
| `billing_auto_quotes` | Postgres | Price/fee quotes protect automatic funding confirmation. [src/auto-topup.ts](../../../src/auto-topup.ts#L62) | — |
| `billing_auto_attempts` | Postgres | Automatic invoice/charge retries and account deletion coordination need one authority. [src/auto-topup.ts](../../../src/auto-topup.ts#L38) | — |
| `help_requests` | Postgres | Tenant support request deduplication and email delivery stay control-plane work. [src/help.ts](../../../src/help.ts#L207) | — |
| `card_checks` | Postgres | Card fingerprint eligibility and awards must remain atomic and survive account deletion. [src/card-credit.ts](../../../src/card-credit.ts#L17) | — |
| `account_deletions` | Postgres | A durable erasure saga tracks tenant denial, per-agent purge and retained legal/accounting records. [src/account-deletion.ts](../../../src/account-deletion.ts#L23) | PURGE |
| `discord_installations` | Postgres | Managed Discord installation identity is shared across tenant agents. [src/discord-managed.ts](../../../src/discord-managed.ts#L221) | — |
| `discord_server_bindings` | Postgres | Server-to-tenant/channel uniqueness must be globally serialized. [src/discord-managed.ts](../../../src/discord-managed.ts#L221) | — |
| `discord_setup_attempts` | Postgres | Server setup nonce/state and retries belong beside its binding. [src/discord-managed.ts](../../../src/discord-managed.ts#L262) | — |
| `discord_account_links (already dropped)` | Delete | Already dropped by 047_drop_discord_account_links.sql; no current src consumer. This is not a new hybrid saving. [migrations/047_drop_discord_account_links.sql](../../../migrations/047_drop_discord_account_links.sql#L3) | — |
| `discord_setup_cooldowns` | Postgres | Provider server setup throttles are shared across accounts. [src/discord-managed.ts](../../../src/discord-managed.ts#L196) | — |
| `busy_agents` | Postgres | Tenant-wide concurrent-run admission is not supplied by DO single-threading; replace node heartbeat columns with expiring reservations. [src/busy-agents.ts](../../../src/busy-agents.ts#L27) | ADMISSION |
| `rate_limits` | Postgres | Multi-Worker account/IP/model request limits require a shared authority. [src/rate-limits.ts](../../../src/rate-limits.ts#L239) | — |
| `telemetry_exporters (already dropped)` | Delete | Already dropped by 094_drop_telemetry_exporters.sql; no current src consumer. This is not a new hybrid saving. [migrations/094_drop_telemetry_exporters.sql](../../../migrations/094_drop_telemetry_exporters.sql#L3) | — |
| `admin_github_bindings` | Postgres | Admin GitHub numeric identity binding protects renamed/reused logins. [src/accounts.ts](../../../src/accounts.ts#L200) | — |
| `billing_disputes` | Postgres | Stripe disputes, balance effects and resolution deduplication remain financial state. [src/billing.ts](../../../src/billing.ts#L333) | — |
| `console_sessions` | Postgres | Console authentication and session revocation are account-scoped. [src/console-auth.ts](../../../src/console-auth.ts#L14) | — |
| `tenant_passwords` | Postgres | Password hashes, reset versions and account lockouts stay with identity authority. [src/passwords.ts](../../../src/passwords.ts#L75) | — |
| `account_email_links` | Postgres | Sign-in/reset/verification links are one-time account credentials. [src/email-accounts.ts](../../../src/email-accounts.ts#L12) | — |
| `journey_accounts` | Postgres | Customer lifecycle/account acquisition aggregates are cross-agent analytics. [src/journey.ts](../../../src/journey.ts#L22) | — |
| `journey_milestones` | Postgres | Idempotent signup/payment/product milestones stay with account events. [src/journey.ts](../../../src/journey.ts#L240) | — |
| `journey_state` | Postgres | Lifecycle delivery/cursor state belongs to shared customer messaging. [src/journey.ts](../../../src/journey.ts#L665) | — |
| `journey_lost_signups` | Postgres | Rejected signup attribution is account acquisition state. [src/journey.ts](../../../src/journey.ts#L35) | — |
| `journey_outbox` | Postgres | Lifecycle email/notification delivery remains a durable shared outbox. [src/journey.ts](../../../src/journey.ts#L13) | — |
| `agent_children` | Agent DO | Parent-owned child handles, budgets and delivery state fit its SQLite; child-to-parent notification is an idempotent message. [src/client-sessions/children.ts](../../../src/client-sessions/children.ts#L90) | CHILD, PURGE, FENCE |
| `agent_wakes` | Postgres | Root-chain hourly wake counter covers different agent DOs; retain atomic shared increments. [src/client-sessions/children.ts](../../../src/client-sessions/children.ts#L520) | CHILD |
| `model_attempts` | Postgres | Attempt identity, uncertain provider outcomes and settled charge revisions stay with money reconciliation. [src/model-attempts.ts](../../../src/model-attempts.ts#L117) | USAGE |
| `end_user_settings` | Postgres | Tenant markup/allowance policy belongs to relational end-user financial authority. [src/end-user-credits.ts](../../../src/end-user-credits.ts#L279) | USAGE |
| `end_users` | Postgres | Locked end-user balances and overrides are shared across the tenant agents. [src/end-user-credits.ts](../../../src/end-user-credits.ts#L15) | USAGE |
| `end_user_ledger` | Postgres | Idempotent allowance/paid movements stay with end-user balance settlement. [src/end-user-credits.ts](../../../src/end-user-credits.ts#L459) | USAGE |
| `end_user_days` | Postgres | Daily allowance consumption must be atomic across agent calls. [src/end-user-credits.ts](../../../src/end-user-credits.ts#L16) | USAGE |
| `end_user_holds` | Postgres | In-flight end-user spending reservations are cross-agent financial state. [src/end-user-credits.ts](../../../src/end-user-credits.ts#L234) | USAGE |
| `voice_sessions` | Postgres | Voice room/session ownership and reconnect/provider lifecycle span agents and transport hosts. [src/voice-sessions.ts](../../../src/voice-sessions.ts#L207) | — |
| `elevenlabs_voices` | Postgres | Shared custom voice cache/identities are keyed by provider account, not one agent. [src/voice/realtime/elevenlabs.ts](../../../src/voice/realtime/elevenlabs.ts#L115) | — |
| `pi_durable_metadata` | Agent DO | Per-agent record allocator, commit sequence and history ordinals need only local SQLite transactions. [src/pi-durable/storage.ts](../../../src/pi-durable/storage.ts#L81) | USAGE, FENCE, PURGE |
| `pi_durable_record_ids` | Agent DO | The record-type/id namespace is private to one agent journal. [src/pi-durable/storage.ts](../../../src/pi-durable/storage.ts#L81) | USAGE, FENCE, PURGE |
| `pi_durable_conversations` | Agent DO | Conversation ownership and forks are private journal state. [src/pi-durable/storage.ts](../../../src/pi-durable/storage.ts#L82) | USAGE, FENCE, PURGE |
| `pi_durable_entries` | Agent DO | Canonical model/tool entries and history placement belong beside execution; keep image bytes outside large rows. [src/pi-durable/storage.ts](../../../src/pi-durable/storage.ts#L82) | USAGE, FENCE, PURGE |
| `pi_durable_tasks` | Agent DO | Task lifecycle and wake state are private to the agent and recovered by its alarm. [src/pi-durable/storage.ts](../../../src/pi-durable/storage.ts#L83) | USAGE, FENCE, PURGE |
| `pi_durable_submissions` | Agent DO | Queued request acceptance/deduplication must commit with the journal that executes it. [src/pi-durable/storage.ts](../../../src/pi-durable/storage.ts#L83) | USAGE, FENCE, PURGE |
| `pi_durable_documents` | Agent DO | Durable tool/input/session documents are private journal state. [src/pi-durable/storage.ts](../../../src/pi-durable/storage.ts#L84) | USAGE, FENCE, PURGE |
| `pi_durable_document_revisions` | Agent DO | Document base/delta revisions need atomicity only with their parent journal. [src/pi-durable/storage.ts](../../../src/pi-durable/storage.ts#L84) | USAGE, FENCE, PURGE |
| `pi_usage_receipts` | Postgres | Retain as billing inbox/deduplication receipt; a new DO outbox replaces its current atomic journal insertion. [src/accounts.ts](../../../src/accounts.ts#L585) | USAGE, PURGE |
| `pi_sweep (already dropped)` | Delete | Already dropped by 084_drop_pi_sweep.sql; no current src consumer. This is not a new hybrid saving. [migrations/084_drop_pi_sweep.sql](../../../migrations/084_drop_pi_sweep.sql#L4) | — |
| `workspaces` | Postgres | These are account organization groups, not per-agent filesystem workspaces. [src/workspaces.ts](../../../src/workspaces.ts#L15) | — |
| `workspace_assignments` | Postgres | Time-versioned membership spans agents and determines historical usage attribution. [src/workspaces.ts](../../../src/workspaces.ts#L32) | USAGE, REGISTRY |
| `workspace_usage` | Postgres | Workspace financial aggregates commit with tenant totals and ledger. [src/workspaces.ts](../../../src/workspaces.ts#L68) | USAGE |
| `schedule_deliveries` | Postgres | Verified email delivery and retry state stays in shared outbox; DO emits a durable delivery command. [src/schedule-mailer.ts](../../../src/schedule-mailer.ts#L25) | SCHEDULE, PURGE |
| `computer_connections` | Postgres | Tenant/provider attachment credentials and child inheritance stay at compute account authority. [src/computers/service.ts](../../../src/computers/service.ts#L45) | REGISTRY |
| `computer_leases` | Postgres | External/BYOC machine lifetimes and billable history remain even when agent hosting moves. [src/computers/service.ts](../../../src/computers/service.ts#L49) | — |
| `computer_commands` | Postgres | Durable external computer command identity/recovery is not replaced by agent DO ownership. [src/computers/service.ts](../../../src/computers/service.ts#L199) | — |
| `computer_operations` | Postgres | Provider effect idempotency and uncertain outcomes remain at compute authority. [src/computers/service.ts](../../../src/computers/service.ts#L164) | — |
| `memory_retirement_guard` | Delete | Retire with ECS memory-retirement behavior; delete the PG table only after every residual host stops using that feature. [src/ownership.ts](../../../src/ownership.ts#L427) | FENCE |
| `voice_recordings` | Postgres | Recording consent, room metadata and object retention span transport/provider lifecycles. [src/voice-sessions.ts](../../../src/voice-sessions.ts#L243) | — |
| `computer_transfers (already dropped)` | Delete | Already dropped by 100_drop_computer_transfers.sql; no current src consumer. This is not a new hybrid saving. [migrations/100_drop_computer_transfers.sql](../../../migrations/100_drop_computer_transfers.sql#L1) | — |
| `credit_holds` | Postgres | Tenant reservations serialize under the same account row lock as shared money. [src/credit-holds.ts](../../../src/credit-holds.ts#L20) | USAGE |
| `managed_computers` | Postgres | Provider machine allocation, paid lifetime and recovery remain compute account authority. [src/computers/managed.ts](../../../src/computers/managed.ts#L200) | — |
| `computer_blocks` | Postgres | Account abuse/concurrency blocks apply across all agent objects. [src/computers/managed.ts](../../../src/computers/managed.ts#L280) | — |
| `end_user_lots` | Postgres | Paid credit lots, expiry and write-offs stay in the end-user settlement transaction. [src/end-user-credits.ts](../../../src/end-user-credits.ts#L232) | USAGE |
