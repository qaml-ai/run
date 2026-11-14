# Core extraction inventory

This plan replaces generated copies with one host-agnostic implementation under `src/core/`. It does not migrate the
runtime to Workers or change production. Phase 1 adds the boundary and moves only calendar policy; the extraction PRs
below are follow-up work.

## Snapshot and counting

The requested `origin/codex/workers-parity-agents` remote ref was absent on 2026-11-05 (`git ls-remote` and fetch).
The inventory uses its retained local branch tip at task start, commit
[`2e385ce0092596b8fc6ae57767be326b58a3177e`](https://github.com/qaml-ai/run/commit/2e385ce0092596b8fc6ae57767be326b58a3177e).
Every generator and output was read with `git show 2e385ce0092596b8fc6ae57767be326b58a3177e:<path>`; no branch checkout
was used. The local branch continued moving during this task, so the SHA, not its current tip, is the reproducible source.
The available `origin/codex/workers-parity` is a different snapshot and was not substituted.

There are **28 `reuse-*.mjs` generators**, producing **119 files / 17,075 physical lines** in this snapshot, rather than
26 / about 16.7k. Counts include comments, imports, scaffolding, blanks and repeated slices. They count file contents,
not unique source logic or the eventual size of core. One file is `backends/workers/codemode/fs-shim.ts` (3 physical
lines containing an encoded multiline program); the other 118 are under `backends/workers/src/`. Test porters,
compatibility harnesses and handwritten host adapters are excluded. Embedded common-password data counts as two lines.

Some dependencies are already imported directly from `src/` (calendar, limits, pricing, among others). Those imports
need a legal core path but are not copied lines. Several generators still retain Node crypto, Buffer, process.env and
timers behind Workers compatibility. A generated filename ending in policy is not evidence that it can enter core.

## Extraction PRs, in risk order

Counts allocate each existing generated file to exactly one retirement PR. A generator spanning PRs is reduced after
each extraction and deleted only at its last consumer; the list below says where that happens. Source logic can move
earlier than whole-file retirement. This is a risk/review order: dependencies discovered while splitting a module
must be made explicit rather than preserving the generator's copied type scaffolding.

| PR | Area | Core target(s), all under `src/core/` | Generated lines retired |
| --- | --- | --- | ---: |
| 1 | Limits, prices and small input policies | `limits.ts`, `pricing.ts`, `platform-pricing.ts`, `access.ts`, `credential-exchange.ts` | 127 |
| 2 | Calendar and schedule rules | `calendar.ts`, `schedules.ts` | 40 |
| 3 | Tool output caps | `tool-output.ts` | 32 |
| 4 | Attachments, inputs and history shapes | `attachments.ts`, `inputs.ts`, `history.ts`, `history-formats.ts` | 661 |
| 5 | Decision, run, reset and delegation policy | `decisions.ts`, `tool-judge.ts`, `sender.ts`, `delegation.ts`, `run-policy.ts`, `reset.ts`, `fork.ts` | 1,667 |
| 6 | Files, volumes and computer policy | `files.ts`, `volumes.ts`, `computers.ts` | 269 |
| 7 | Model catalog, routing and output policy | `model-catalog.ts`, `model-routing.ts`, `model-config.ts`, `model-stream.ts`, `output.ts` | 1,616 |
| 8 | Provider and key-scope policy | `key-scopes.ts`, `model-providers.ts`, `key-check.ts` | 524 |
| 9 | Tool calls and OpenAPI sources | `tool-calls.ts`, `tool-sources.ts`, `openapi.ts` | 194 |
| 10 | Web providers and outbound policy | `web-search.ts`, `web-render.ts`, `web-fetch.ts`, `capability-routing.ts`, `outbound-policy.ts` | 851 |
| 11 | Media policy and metric formatting | `images.ts`, `transcription.ts`, `speech.ts`, `metrics.ts` | 1,421 |
| 12 | Accounts, auth, HTTP and admin queries | `auth/`, `accounts.ts`, `tenants.ts`, `identity.ts`, `http.ts`, `idempotency.ts`, `admin/`, `workspaces.ts` | 4,292 |
| 13 | Billing and payment ledger | `billing.ts`, `billing-payments.ts`, `billing-alerts.ts`, `stripe.ts`, `storage-usage.ts` | 2,185 |
| 14 | End-user credit, holds, attempts and spend | `end-user-credits.ts`, `credit-holds.ts`, `model-attempts.ts`, `model-usage.ts`, `spend.ts`, `webhooks.ts` | 3,196 |
| | **Total** | | **17,075** |

### PR 1: Limits, prices and small input policies

Start with scalar limits, unit conversion, tier selection and charge arithmetic. Pass pricing/catalog data explicitly. These policies have no SQL or lifecycle. Includes already-direct imports of limits/pricing; they add no generated-copy lines.

Reduces `reuse-access-policy`, `reuse-exchange-policy` and `reuse-money`; deletes the first two generators. Limits/pricing direct imports move here too.

Retired copies (`backends/workers/src/` unless prefixed `../`):

`access-policy.ts` (3); `exchange-policy.ts` (20); `platform-pricing.ts` (104).

### PR 2: Calendar and schedule rules

Keep wall-time/DST and retry rules unchanged. Scheduler claims, dispatch and timers remain host code. This PR supplies the calendar portion; finish schedule validation next.

Deletes `reuse-schedules` after schedule-policy moves. Calendar itself was already a direct source import and has no generated copy to retire.

Retired copies (`backends/workers/src/` unless prefixed `../`):

`schedule-policy.ts` (40).

### PR 3: Tool output caps

Keep UTF-8 byte limits and saved-result behavior; accept the existing save callback and use TextEncoder. No filesystem implementation moves.

Deletes `reuse-tool-output`.

Retired copies (`backends/workers/src/` unless prefixed `../`):

`tool-output-policy.ts` (32).

### PR 4: Attachments, inputs and history shapes

Share parsing/rendering and answer policies. Preserve schema-validation semantics when replacing the Workers pi-schema substitution; keep sealed values opaque and pass current time where required.

Deletes `reuse-attachments` and `reuse-inputs`; reduces `reuse-model-policy` (history pieces).

Retired copies (`backends/workers/src/` unless prefixed `../`):

`attachment-policy.ts` (160); `input-policy.ts` (207); `history-policy.ts` (84); `history-formats.ts` (210).

### PR 5: Decision, run, reset and delegation policy

Extract pure validation, prompts, failure classification and budget decisions first. Keep provider transports, decision gates, session lookup and timer ownership in hosts; replace hash/byte operations explicitly. This retires wrappers only after all their selected policy pieces move.

Deletes `reuse-decision-policy`, `reuse-run-policy`, `reuse-reset-policy` and `reuse-fork-policy`.

Retired copies (`backends/workers/src/` unless prefixed `../`):

`multi-agent-policy.ts` (310); `decision-policy.ts` (547); `tool-judge.ts` (198); `decision-providers.ts` (100); `sender-markers.ts` (23); `sender.ts` (115); `delegation-policy.ts` (44); `reset-policy.ts` (24); `fork-policy.ts` (34); `model-error-classification.ts` (44); `model-stream-failure.ts` (3); `model-errors.ts` (116); `model-key-failure.ts` (6); `tool-approval-prompt.ts` (5); `prompt-policy.ts` (94); `file-tool-policy.ts` (4).

### PR 6: Files, volumes and computer policy

Share path/label/media policy and computer command descriptions. Keep storage, mounts, snapshots and VM execution host-owned. Signed grants need async Web Crypto or a narrow signer callback. The sandbox FS payload is an explicit exception described below.

Deletes `reuse-volume-policy`, `reuse-computers` and `reuse-fs-shim` once the sandbox asset is shared as described below.

Retired copies (`backends/workers/src/` unless prefixed `../`):

`volume-policy.ts` (56); `file-policy.ts` (137); `computers/policy.ts` (44); `computers/microvm-policy.ts` (29); `../codemode/fs-shim.ts` (3).

### PR 7: Model catalog, routing and output policy

Move catalog data and routing without installing Pi packages blindly: audit their import/type graphs first. Replace ambient config and stream timer assumptions. Unify repeated pi-catalog/deepseek/catalog slices; static model JSON becomes a pure input or core asset.

Reduces `reuse-model-policy`, `reuse-security` and `reuse-money`; model-policy still generates provider-policy until PR8.

Retired copies (`backends/workers/src/` unless prefixed `../`):

`model-catalog.ts` (258); `azure-policy.ts` (135); `default-model-policy.ts` (55); `catalog-policy.ts` (115); `model-policy.ts` (276); `deepseek-policy.ts` (73); `model-stream.ts` (145); `output-policy.ts` (43); `output-validation.ts` (76); `pi-catalog.ts` (258); `key-catalog.ts` (65); `security-types.ts` (43); `security-deepseek.ts` (74).

### PR 8: Provider and key-scope policy

Preserve header/endpoint validation and custom provider rules. SQL, credential sealing and outbound reachability enter through explicit arguments. Share full policy once its pure pieces in PR7 exist.

Deletes `reuse-model-policy` after provider-policy moves; reduces `reuse-security`.

Retired copies (`backends/workers/src/` unless prefixed `../`):

`provider-policy.ts` (103); `key-scopes.ts` (163); `model-providers.ts` (218); `key-check.ts` (40).

### PR 9: Tool calls and OpenAPI sources

Share metadata, approval, audience, reference resolution and form encoding. Hash call IDs with Web Crypto or an explicit digest adapter. Keep MCP transport, source persistence and fetching outside core.

Deletes `reuse-tool-calls`, `reuse-source-input` and `reuse-openapi`.

Retired copies (`backends/workers/src/` unless prefixed `../`):

`tool-call-policy.ts` (61); `openapi-policy.ts` (124); `source-input-policy.ts` (9).

### PR 10: Web providers and outbound policy

Use Config/Log and explicit bounded outbound/file-save services. Preserve address checks and redirect behavior across native fetch/Undici differences. DNS/socket policy remains a host implementation.

Deletes `reuse-web-policy`; reduces `reuse-security` (address/fetch policies).

Retired copies (`backends/workers/src/` unless prefixed `../`):

`web-search-policy.ts` (296); `x-search-policy.ts` (98); `web-render-policy.ts` (74); `capability-router.ts` (52); `web-definitions.ts` (39); `web-fetch-policy.ts` (42); `public-address-policy.ts` (107); `web-transfer-policy.ts` (25); `security-addresses.ts` (64); `security-fetch-policy.ts` (54).

### PR 11: Media policy and metric formatting

Share validation, provider payload/response policy and metric formatting. Hosts retain audio execution/transport, file saves and usage services. Replace Buffer codecs and make sink/cache state per-instance.

Deletes `reuse-media`.

Retired copies (`backends/workers/src/` unless prefixed `../`):

`media/images.ts` (419); `media/transcription.ts` (234); `media/speech.ts` (183); `media/speech-api.ts` (195); `media/voice-providers/tts.ts` (132); `media/voice-providers/tts-chain.ts` (118); `media/files-policy.ts` (9); `metrics-policy.ts` (131).

### PR 12: Accounts, auth, HTTP and admin queries

Move OAuth/password/console/browser-token policy and Sql-backed queries. Preserve password hashes and token formats; scrypt needs a host KDF seam because Web Crypto does not provide it. Keep secrets, tenant file loading, identity async context, timers and HTTP mounting on hosts. Accounts money methods stay for PR14.

Deletes `reuse-accounts`, `reuse-http` and `reuse-admin`; reduces `reuse-security` and `reuse-money` (workspaces).

Retired copies (`backends/workers/src/` unless prefixed `../`):

`account-console-auth.ts` (442); `account-email-accounts.ts` (193); `account-passwords.ts` (119); `account-oauth.ts` (544); `account-signup-source.ts` (43); `account-origins.ts` (57); `account-rate-limits.ts` (416); `account-common-passwords.ts` (2); `account-access.ts` (15); `admin/admin-accounts.ts` (126); `admin/admin-acquisition.ts` (98); `admin/admin-growth.ts` (153); `admin/admin-health.ts` (175); `admin/admin-mcp.ts` (83); `admin/admin-revenue.ts` (193); `admin/admin-signals.ts` (201); `admin/admin-stats.ts` (90); `admin/admin-usage.ts` (363); `idempotency.ts` (86); `runtime-identity.ts` (175); `idempotency-routes.ts` (4); `http-error-policy.ts` (38); `tenants.ts` (308); `browser-tokens.ts` (135); `security-policy.ts` (38); `admission-errors.ts` (18); `postgres-policy.ts` (74); `security-inputs.ts` (25); `workspaces.ts` (78).

### PR 13: Billing and payment ledger

Preserve ledger locking, idempotency, payment/verification rules, transactional retry opt-outs and external-call boundaries. Recurring jobs, storage reconciliation and Stripe I/O use host adapters. Delete the duplicated billing-sql slice with the full billing implementation.

Deletes `reuse-billing`; reduces `reuse-sql` (billing-sql).

Retired copies (`backends/workers/src/` unless prefixed `../`):

`billing.ts` (778); `billing-payments.ts` (224); `auto-topup.ts` (364); `card-credit.ts` (110); `billing-alerts.ts` (311); `stripe.ts` (112); `storage-usage.ts` (177); `billing-inputs.ts` (26); `billing-sql.ts` (83).

### PR 14: End-user credit, holds, attempts and spend

Move monetary settlement last. Preserve lots, allowances, reservation/renewal, event atomicity, attribution and recovery. Finish splitting Accounts usage batching from identity, then delete its whole copy and the remaining security generator. Hosts retain background flush/delivery ownership.

Deletes `reuse-sql`, `reuse-money`, `reuse-money-metrics`, `reuse-spend-policy` and the remaining `reuse-security`.

Retired copies (`backends/workers/src/` unless prefixed `../`):

`money-event-metrics.ts` (73); `money-limit-metrics.ts` (61); `credit-holds.ts` (59); `model-attempts.ts` (400); `model-attempt.ts` (39); `model-attempt-stream.ts` (119); `webhook-policy.ts` (395); `money-tokens.ts` (90); `model-call-fetch.ts` (63); `model-estimate.ts` (12); `accounts.ts` (735); `agent-spend-policy.ts` (26); `end-user-credits.ts` (1,124).

The FS shim comes from `sandbox/v8-exec/src/pi-glue.js`, not `src/`. PR6 must first publish a single canonical
sandbox source/string asset and have both executors consume it; `src/core/files.ts` holds only its host-independent
file policy. Do not paste an encoded second implementation into core to make the generator disappear. Removing the
extractor may require a shared build asset outside core as well as this core module. This exception is included in the
retirement count so no generator is silently dropped from the inventory.

## Minimal host contracts for Phase 1

`src/core/host.ts` defines types only; hosts are not rewritten in this PR.

| Contract | Evidence and semantics |
| --- | --- |
| `Sql`, `Rows` | Same `query<R>(text, values?) -> {rows, rowCount: number|null}` shape as `src/db.ts`. Used by billing, credits, admin queries, idempotency and auth. No Pool, driver, connect/end or connection counters in core. |
| `Transaction` | Bound form of `transaction(db, work, {rerun?})`; callback receives `Sql`. Preserve one connection, commit/rollback, serialization/deadlock retries (three attempts on Node) and `rerun:false` for nonrepeatable effects. See `reuse-security`'s postgres-policy, `reuse-sql` and `src/db.ts`. |
| `Clock` | `now()` and abortable `sleep(ms, {signal?})`, from the used subset of `src/node-context.ts`; `reuse-money` supplies sleep, retry/expiry code uses time. Do not expose Node timer handles, unref or scheduling ownership. Calendar takes timestamps directly. |
| `Log` | A prepared, sanitized line sink matching JSON-line output. No logger class or log-level hierarchy is required by these call sites. |
| `Metrics` | A serialized line sink matching `src/metrics.ts:setMetricSink`, `reuse-money-metrics`'s writeMetricLine and Workers observability. Metric calculation/privacy remains policy; CloudWatch/AnalyticsEngine output remains host-owned. |
| `Config` | Read-only string/undefined map for existing environment parsers in pricing, tenants, model and web configuration. No ambient process.env. |

Do not add one universal host object. Existing function-specific callbacks (save a tool result, seal a credential,
fetch a bounded URL) stay narrow and acquire shared interfaces only when their extraction needs them. Browser APIs
supply fetch and Web Crypto primitives, but hosts still own outbound authorization. Scrypt, identity async context,
DNS/IP parsing, object stores, locks and timer scheduling need deliberate adapters or pure replacements later. This
inventory does not claim the six initial contracts solve those dependencies.

Phase 1 copies the **34-line** `src/calendar.ts` implementation byte-for-byte to `src/core/calendar.ts`; the original
path re-exports its three functions and `Calendar` type. No Workers files are added here. Existing tests retain their
imports. `check:core`, included in CI's `typecheck`, rejects forbidden imports/globals and symlinks, bundles every core
module with esbuild `platform: neutral`, and checks an independent `types: []`, ES2024 + WebWorker TypeScript project.

## Generator-by-generator evidence

The entries below distinguish exact selected source declarations from generated scaffolding. “Whole file” includes
all methods and nested helpers in that source file. Copy paths are relative to `backends/workers/src/` except the FS
shim. Infrastructure descriptions include dependencies the Workers copy still retains, not just substitutions.

## reuse-access-policy.mjs

- Source/extraction: `src/client-sessions.ts`: `UPSERT_KEYS` array and the configure-path restricted-key array (renamed `TENANT_CONFIGURATION_KEYS`). No functions.
- Infrastructure/Workers substitute: No infrastructure replacement; generated `UPSERT_KEYS` stays private.
- Difficulty: Pure.
- Copies (`backends/workers/src/` unless noted):
  - `access-policy.ts` (3 lines): `UPSERT_KEYS`, `TENANT_CONFIGURATION_KEYS`.
- Total copies: **3 lines**.

## reuse-accounts.mjs

- Source/extraction: Whole `src/{console-auth,email-accounts,passwords,oauth,signup-source,origins,rate-limits}.ts`; `src/common-passwords.txt` becomes a string export; `src/api.ts` `OAUTH_ROUTES` array plus newly written `oauthAllows`.
- Infrastructure/Workers substitute: Rewrites db→`postgres`, HTTP→`account-http`, password/email/console/origin/rate/sign-up cross-imports→`account-*`, node-context→`account-network`, journey→`account-journey`, metrics→`account-metrics`. Only passwords fs asset read is removed: `readFileSync`→bundled `commonPasswords`. Node crypto (hash, HMAC, random, cipher, timing-safe comparison, scrypt), `node:net` isIP, Buffer, Date.now, console, intervals/timeouts/unref remain, as do Hono/jose and type-only Accounts imports. `account-network` wraps fetch and rejects redirects with manual mode; account HTTP bounds Web stream reads; metrics redacts to error class. No crypto substitution yet.
- Difficulty: Needs Sql + other interfaces. Auth state, key derivation and timers are tangled with host lifecycle. Split validation/static config from async crypto/identity/SQL before migration.
- Copies (`backends/workers/src/` unless noted):
  - `account-console-auth.ts` (442 lines): `ConsoleAuthOptions`, `SignIn`, `ConsolePrincipal`, `personal`, `WRONG_PASSWORD`, `GOOGLE_ISSUER`, `CONSOLE_HEADER`, `SESSION_COOKIE`, `STATE_COOKIE`, `NEXT_COOKIE`, `GOOGLE_COOKIE`, `SOURCE_COOKIE`, `nextPath`, `sha256`, `same`, `discover`, `cookies`, `ConsoleAuth`.
  - `account-email-accounts.ts` (193 lines): `VERIFY_MS`, `RESET_MS`, `LINK_GONE`, `LinkPurpose`, `Link`, `sha256`, `TOKEN`, `EmailAccountsOptions`, `EmailAccounts`.
  - `account-passwords.ts` (119 lines): `COST`, `KEY_BYTES`, `MAX_MEMORY`, `MIN_PASSWORD`, `MAX_PASSWORD`, `derive`, `hashPassword`, `verifyPassword`, `normalizeEmail`, `COMMON`, `checkNewPassword`, `checkPassword`, `Passwords`.
  - `account-oauth.ts` (544 lines): `OAuthOptions`, `SCOPE`, `OPS_SCOPE`, `OPS_PATH`, `OPS_METADATA_PATH`, `OAuthResource`, `ACCESS_TOKEN_MS`, `REFRESH_TOKEN_MS`, `REFRESH_GRACE_MS`, `CODE_MS`, `ACCESS`, `AUTH_METHODS`, `AuthMethod`, `Client`, `Grant`, `OAuthPrincipal`, `sha`, `b64`, `same`, `sealKey`, `seal`, `unseal`, `AGENT_RESOURCE`, `LOOPBACK`, `escape`, `OAuthError`, `OAuth`, `validRedirect`, `destinationOf`, `redirectMatches`, `PAGE_HEADERS`, `PAGE`.
  - `account-signup-source.ts` (43 lines): `SignupSource`, `REF`, `HOST`, `signupSource`, `keptSignupSource`, `recordSignupSource`.
  - `account-origins.ts` (57 lines): `PublicOrigins`, `origin`, `publicOrigins`.
  - `account-rate-limits.ts` (416 lines): `MINUTE`, `DAY`, `PASSWORD_WINDOW_SECONDS`, `MAX_BUCKETS`, `WORKERS_ADDRESS`, `RateLimit`, `RateLimitState`, `rateLimitHeaders`, `RateLimited`, `RateLimitConfig`, `rateLimitConfig`, `Header`, `clientAddress`, `loopback`, `clientKey`, `RateLimitOptions`, `RateLimits`.
  - `account-common-passwords.ts` (2 lines): `commonPasswords`.
  - `account-access.ts` (15 lines): `OAUTH_ROUTES`, `oauthAllows`.
- Total copies: **1,831 lines**.

## reuse-admin.mjs

- Source/extraction: Whole `src/admin-{accounts,acquisition,growth,health,mcp,revenue,signals,stats,usage}.ts`; every class/function/helper and SQL query.
- Infrastructure/Workers substitute: Only db→`../postgres`, signup-source→`../account-signup-source`; `mcp-client-kind` remains a direct non-core source import. Postgres adapter uses per-operation Hyperdrive Client and holds one connection for transaction; Date.now defaults remain. No cloud/AWS calls in these read queries.
- Difficulty: Needs Sql; pure date/redaction helpers can move first. Snapshot-consistent transactions must retain semantics.
- Copies (`backends/workers/src/` unless noted):
  - `admin/admin-accounts.ts` (126 lines): `DAY_MS`, `ADMIN_WINDOW_DAYS`, `ADMIN_MAX_WINDOW_DAYS`, `SELF_SERVE`, `counted`, `staff`, `SIGN_IN`, `AdminAccountKind`, `AdminAccountName`, `NAME_COLUMNS`, `accountName`, `AdminWindow`, `AdminWindowError`, `utcDate`, `startOfUtcDay`, `adminWindow`, `windowOf`, `windowDates`, `usageKind`, `AdminUsageKind`, `modelCall`, `MODEL_CALL`, `liveAgent`, `AdminCompare`, `snapshot`, `n`.
  - `admin/admin-acquisition.ts` (98 lines): `AdminSourceKind`, `AdminSource`, `AdminAcquisition`, `blank`, `sourceOf`, `adminAcquisition`.
  - `admin/admin-growth.ts` (153 lines): `AdminGrowthDay`, `AdminCohort`, `AdminFunnel`, `AdminGrowth`, `ADMIN_COHORT_WEEKS`, `adminGrowth`.
  - `admin/admin-health.ts` (175 lines): `AdminSpendDay`, `AdminPayer`, `AdminSpendAccount`, `AdminCheck`, `AdminNode`, `AdminHealth`, `KINDS`, `MINUTE`, `plural`, `ago`, `adminHealth`.
  - `admin/admin-mcp.ts` (83 lines): `mcpSignupAttribution`, `AdminMcp`, `adminMcp`.
  - `admin/admin-revenue.ts` (193 lines): `AdminRevenueDay`, `AdminRevenueMonth`, `AdminFreeCreditBucket`, `AdminFreeCreditAccount`, `AdminRevenue`, `ADMIN_FREE_CREDIT_ROWS`, `CENT`, `freeCreditBucket`, `adminRevenue`.
  - `admin/admin-signals.ts` (201 lines): `AdminRange`, `AdminActivationCoverage`, `AdminSignalsDay`, `AdminSignals`, `AdminRangeError`, `ADMIN_TIME_ZONE`, `ADMIN_MAX_DAYS`, `DAY_MS`, `CENT`, `dateFormat`, `adminToday`, `calendarDate`, `adminDays`, `COUNTED`, `adminSignals`, `AdminTrendDay`, `AdminTrend`, `ADMIN_TREND_DAYS`, `ADMIN_TREND_MAX_DAYS`, `adminTrend`.
  - `admin/admin-stats.ts` (90 lines): `AdminDay`, `AdminSignup`, `AdminStats`, `DAY_MS`, `adminStats`.
  - `admin/admin-usage.ts` (363 lines): `AdminUsageDay`, `AdminModelRow`, `AdminConfiguredModel`, `AdminFeature`, `AdminIntegration`, `AdminUsageAccount`, `AdminTopAgent`, `AdminUsage`, `TOP_MODELS`, `TOP_ACCOUNTS`, `TOP_AGENTS`, `FEATURES`, `INTEGRATIONS`, `adminUsage`, `AdminAccountAgent`, `AdminAccountDetail`, `ADMIN_PROMPT_CHARS`, `ADMIN_ACCOUNT_AGENTS`, `maskSecrets`, `hostOf`, `adminAccount`.
- Total copies: **1,482 lines**.

## reuse-attachments.mjs

- Source/extraction: `src/files.ts`: from `FileTranscript` through before signed-link comment (file metadata/rendering block), plus `textual`; `src/client-sessions/tools.ts`: the opening validation block of `attach` before volume resolution; `src/inspect.ts`: `firstLines` through EOF.
- Infrastructure/Workers substitute: Typed Buffer import retained for UTF-8 bytes and decoding; Pi Api/Model types retained; limits direct import retained; HttpError→Workers errors. `!ctx.options.outbound` becomes `!canFetchURL`. No SQL/file I/O in extracted body.
- Difficulty: Needs other interfaces/byte helper; mostly pure, replace Buffer via TextEncoder/Decoder and inject existing HTTP error dependency.
- Copies (`backends/workers/src/` unless noted):
  - `attachment-policy.ts` (160 lines): `FileTranscript`, `Media`, `FileRef`, `validFileRef`, `nativeBlock`, `supportsDocuments`, `fileChars`, `unseen`, `safeName`, `IMAGE_PAST_BUDGET`, `describeFile`, `documentPayload`, `attachmentInputs`, `textual`, `firstLines`.
- Total copies: **160 lines**.

## reuse-billing.mjs

- Source/extraction: Whole `src/{billing,billing-payments,auto-topup,card-credit,billing-alerts,stripe,storage-usage}.ts`; selected `src/api-schemas.ts` variables: all 12 listed below.
- Infrastructure/Workers substitute: db→postgres; HTTP→errors; tenants/busy-agents/metrics/journey/shared-storage/storage-usage/Accounts types→billing-host; node-context network→account-network; pricing/limits remain direct src imports. `billing-host` supplies tenant config, Accounts seal/unseal, journey, object storage meter and billing-limit projections. Zod `.openapi()` annotations are AST-stripped. Node crypto/HMAC/randomUUID/randomInt, Buffer, Date.now, console, polling intervals/unref remain. Stripe network adapter preserves redirect error and timeout policy.
- Difficulty: Needs Sql + other interfaces; tangled with recurring jobs, caches, locks, ledger/idempotency and storage reconciliation. Money last; preserve transaction retry and external-call boundaries.
- Copies (`backends/workers/src/` unless noted):
  - `billing.ts` (778 lines): `BillingMode`, `LimitSource`, `TierValue`, `LedgerKind`, `LEDGER_KINDS`, `LedgerEntry`, `LedgerRow`, `StartingCredit`, `UsageCharge`, `Account`, `DISPUTE_RESTORED`, `BALANCE_CACHE_MS`, `MODE_CACHE_MS`, `JOB_CLAIM_MS`, `usd`, `PURPOSE`, `CENT`, `HOUR`, `MINUTE`, `postLedger`, `accrueUsage`, `BillingOptions`, `Billing`.
  - `billing-payments.ts` (224 lines): `PURPOSE`, `CENT`, `SAFE_RETRY_MS`, `UUID`, `stripeId`, `CheckoutOrder`, `BillingPayments`.
  - `auto-topup.ts` (364 lines): `HOUR`, `active`, `Card`, `AutoTerms`, `displayCard`, `periodAt`, `resetsAt`, `AutoTopup`.
  - `card-credit.ts` (110 lines): `CARD_CHECK`, `CardCheckOutcome`, `CardCredit`.
  - `billing-alerts.ts` (311 lines): `AlertChoices`, `BillingRecipient`, `BillingAlertsView`, `SecretStore`, `DEFAULT_CHOICES`, `HOUR`, `sha`, `aad`, `view`, `emailInput`, `choicesInput`, `lockTenant`, `currentProblem`, `BillingAlerts`.
  - `stripe.ts` (112 lines): `StripeOptions`, `STRIPE_API_VERSION`, `StripeError`, `TOLERANCE_SECONDS`, `formEncode`, `Stripe`, `signWebhook`.
  - `storage-usage.ts` (177 lines): `OwnerKind`, `storageOwner`, `PREFIXES`, `StorageUsage`.
  - `billing-inputs.ts` (26 lines): `BillingAlertChoices`, `BillingRecipientInput`, `BillingAlertThreshold`, `BillingConfirmationInput`, `AdjustmentInput`, `StartingCreditGrantInput`, `BillingPortalInput`, `CheckoutInput`, `CardCheckConfirmInput`, `AutoTopupTerms`, `AutoTopupConsent`, `AutoTopupRetry`.
- Total copies: **2,102 lines**.

## reuse-computers.mjs

- Source/extraction: `src/computers/providers.ts`: `PROVIDERS` through before provider documentation and `quote` through before internal-file documentation; `src/computers/service.ts`: `parameters` through before `publicConnection`; `src/computers/managed.ts`: file-command comment through EOF; `src/computers/microvm.ts`: `MICROVM_MAX_SECONDS` through before `MicrovmSettings`, `paths` through before local-AWS-service comment, `Observation` through before `microvmMachines`.
- Infrastructure/Workers substitute: Provider tool metadata/shapes and shell quoting reused; writes lightweight ToolDefinition and HttpError import. MicroVM AWS/runtime execution deliberately excluded; command body still uses Buffer.from(...).toString(base64).
- Difficulty: Mostly pure but needs byte encoding helper. Keep executable provider/VM lifecycle on host; MicroVM price/observation projection can be shared.
- Copies (`backends/workers/src/` unless noted):
  - `computers/policy.ts` (44 lines): `ToolDefinition`, `PROVIDERS`, `Provider`, `isBrowserProvider`, `Credentials`, `Reference`, `ComputerDriver`, `quote`, `bounded`, `boundedCommand`, `shell`, `output`, `parameters`, `text`, `tool`, `COMMON`, `SHELL`, `BROWSER`, `COMPUTER_TOOLS`, `fileCommand`, `storable`.
  - `computers/microvm-policy.ts` (29 lines): `MICROVM_MAX_SECONDS`, `MICROVM_HOUR`, `paths`, `Observation`, `timestamp`, `paused`, `observe`, `microvmCost`.
- Total copies: **73 lines**.

## reuse-decision-policy.mjs

- Source/extraction: Whole `src/{multi-agent,decisions,tool-judge,decision-providers,sender}.ts`; `sender.ts` marker prefix is ALSO duplicated separately; `src/client-sessions/spend.ts`: delegate-spend comment through before background-child-spend comment; `src/client-sessions/delegation.ts`: child-of-model comment through before child-prompt comment.
- Infrastructure/Workers substitute: HTTP/errors, sender markers, protocol/state/identity/MCP result types and metrics functions→`policy-host`; limits stays direct source import; outbound→`policy-host`. Sender switches AgentMessage type from pi-agent-core to Pi Message. Delegation scaffolding hand-defines Session/Mount/SpendContext; replaces budgetLeft with async ctx.left projection. Node createHash, timers/Date.now, in-memory gates and console remain in whole files; outbound performs bounded fetch.
- Difficulty: Needs other interfaces; pure parsing/prompt policy separate from Decider queue/gate, provider fetch, metrics and budget/session state. Delegation body is not drop-in for ECS because scaffolding flattens budget lookup.
- Copies (`backends/workers/src/` unless noted):
  - `multi-agent-policy.ts` (310 lines): `MULTI_AGENT_LIMITS`, `AgentTarget`, `DelegateSettings`, `SUBAGENT_EVENTS`, `PARENT_KEYS`, `NAME`, `KEY`, `integer`, `targetsInput`, `delegateInput`, `limitsOnly`, `MULTI_AGENT_BUILTINS`, `startsChildren`, `delegateSettings`, `definitionId`, `listed`, `filesSeen`, `targetProperties`, `requiredTarget`, `SUBAGENT_PROMPT`, `roleAndTask`, `delegateTool`, `agentsTools`, `SEND_MESSAGE`, `REPORT_PROGRESS`, `ChildProgress`, `ago`, `agentUpdates`, `ChildStatus`, `Ended`, `childStatus`, `AgentSource`, `childNotice`, `ChildNotice`, `agentMessage`.
  - `decision-policy.ts` (547 lines): `NoulQuestion`, `ChoiceQuestion`, `ScoreQuestion`, `Question`, `State`, `DecisionItem`, `NoulAnswer`, `ChoiceAnswer`, `ScoreAnswer`, `Answer`, `DECISION_MODELS`, `DECISION_MODEL`, `CHARS_PER_TOKEN`, `ID`, `isRecord`, `text`, `questionInput`, `decisionItem`, `DecisionRequest`, `decideInput`, `decisionRequest`, `itemChars`, `ProviderDecision`, `DecisionCredentials`, `DecisionProvider`, `DecisionFailed`, `probability`, `malformed`, `checkedAnswers`, `ItemResult`, `Decided`, `DeciderOptions`, `DecisionBounds`, `Gate`, `abortable`, `Decider`, `DecisionsRequest`, `DecisionService`, `decisionsRequest`, `decisionsAnswer`, `QUESTIONS_SCHEMA`, `DECIDE`, `decideTool`.
  - `tool-judge.ts` (198 lines): `Judged`, `JudgeInput`, `Judge`, `DANGER`, `QUESTIONS`, `judgeable`, `judgeState`, `edges`, `judgeItem`, `probability`, `judgedOutcome`, `UNJUDGED`, `JudgeContext`, `toolJudge`, `DENIED_PERMISSION`.
  - `decision-providers.ts` (100 lines): `openrouterDecisions`, `wireQuestions`, `errorDetail`, `retryAfter`.
  - `sender-markers.ts` (23 lines): `CONTEXT_OPEN`, `CONTEXT_CLOSE`, `MARKER`, `AGENT_TAG`, `AGENT_UPDATES`, `MessageSource`, `SENDER_INSTRUCTIONS`, `escapeMarkers`.
  - `sender.ts` (115 lines): `Sender`, `CONTEXT_OPEN`, `CONTEXT_CLOSE`, `MARKER`, `AGENT_TAG`, `AGENT_UPDATES`, `MessageSource`, `SENDER_INSTRUCTIONS`, `escapeMarkers`, `senderInput`, `METADATA_LIMITS`, `METADATA_ERROR`, `metadataInput`, `contextBlock`, `Part`, `escapeParts`, `escapeResult`, `attribute`, `noticeBlock`, `renderMessage`, `renderMessages`, `Stamp`, `stamp`.
  - `delegation-policy.ts` (44 lines): `DelegateResponse`, `Session`, `SpendContext`, `budgetLeft`, `Mount`, `holdBudget`, `releaseBudget`, `childMounts`.
- Total copies: **1,337 lines**.

## reuse-exchange-policy.mjs

- Source/extraction: `src/credential-exchange.ts`: `EXCHANGE_LIMITS` through before `type Entry`, exposing private `TOKEN` as exported constant.
- Infrastructure/Workers substitute: No replacement; excludes in-memory exchange entries, expiry/lifecycle and credential operations.
- Difficulty: Pure.
- Copies (`backends/workers/src/` unless noted):
  - `exchange-policy.ts` (20 lines): `EXCHANGE_LIMITS`, `TOKEN`.
- Total copies: **20 lines**.

## reuse-fork-policy.mjs

- Source/extraction: `src/pi-durable/fork.ts`: `refused` through before Pi-model-context comment: `refused`, `callsOf`, `forkCount`.
- Infrastructure/Workers substitute: AgentMessage type becomes Pi Message; hand-written JournalHistory subset; excludes Pi context/storage runtime.
- Difficulty: Pure policy; shape types should be shared rather than copied.
- Copies (`backends/workers/src/` unless noted):
  - `fork-policy.ts` (34 lines): `JournalHistory`, `refused`, `callsOf`, `forkCount`.
- Total copies: **34 lines**.

## reuse-http.mjs

- Source/extraction: Whole `src/idempotency.ts` and `src/identity.ts`; `src/api.ts` AST locates `idempotency({...})` and extracts `skip`/`secret` functions renamed `skipMoneyIdempotency`/`secretMoneyIdempotency`; `src/http.ts` AST selects exactly `errorFields`, `STATUS_CODES`, `errorCode`, `errorHeaders`, `errorStatus`.
- Infrastructure/Workers substitute: db→postgres, HTTP→errors; error classification→postgres-policy. Identity still imports Accounts, jose, AsyncLocalStorage, crypto and Buffer. Idempotency still node createHash, Buffer/date and SQL. Hono middleware interfaces retained.
- Difficulty: Error/route policy pure after dependency split; idempotency needs Sql/hash; RuntimeSigner needs Sql + crypto + identity context. AsyncLocalStorage belongs in host.
- Copies (`backends/workers/src/` unless noted):
  - `idempotency.ts` (86 lines): `IDEMPOTENCY_TTL_MS`, `MAX_BODY_BYTES`, `idempotency`, `fingerprintOf`, `expireIdempotencyKeys`.
  - `runtime-identity.ts` (175 lines): `AgentIdentity`, `TokenClaims`, `FileGrant`, `FILE_AUDIENCE`, `FILE_TYPE`, `ALGORITHM`, `TOKEN_SECONDS`, `KEYS_TTL_MS`, `aad`, `ED25519_PKCS8`, `ed25519Key`, `Keys`, `base64url`, `signJwt`, `callScope`, `RuntimeSigner`, `identityInput`, `actorInput`.
  - `idempotency-routes.ts` (4 lines): `skipMoneyIdempotency`, `secretMoneyIdempotency`.
  - `http-error-policy.ts` (38 lines): `errorFields`, `STATUS_CODES`, `errorCode`, `errorHeaders`, `errorStatus`.
- Total copies: **303 lines**.

## reuse-inputs.mjs

- Source/extraction: `src/inputs.ts`: `InputKind` through before Sealer; `INPUT_LIMITS` through before FINAL; clip block and responder-name block through tool-input docs; `inputRequests` through before row mapper; expiry-policy comment through EOF. `src/client-sessions/inputs.ts`: batch-answer comment through before whether-agent-has-someone comment; approver comment/function through next comment.
- Infrastructure/Workers substitute: HttpError→Workers errors; Sender type→Workers sender; AJV/schema path becomes pi-schema compile(schema).check(value); Sealed is hand-written object type. Keeps Date.now defaults; excludes DB row loading, lifecycle and account sealer.
- Difficulty: Mostly pure, needs explicit current-time values. Validate schema engine parity when sharing (Workers currently uses Pi compile).
- Copies (`backends/workers/src/` unless noted):
  - `input-policy.ts` (207 lines): `schemaAccepts`, `Sealed`, `InputKind`, `InputState`, `Action`, `Responder`, `Answer`, `Input`, `Stored`, `InputRow`, `RetryPlan`, `HumanInputSettings`, `INPUT_LIMITS`, `clip`, `responderName`, `waited`, `inputRequests`, `questionsInput`, `questionMessage`, `answerInput`, `mayAnswer`, `CLOSED`, `resolution`, `expiresAt`, `humanInputSettings`, `answerList`, `approver`.
- Total copies: **207 lines**.

## reuse-media.mjs

- Source/extraction: Whole `src/{images,transcription,speech,speech-api,voice-providers/tts,voice-providers/tts-chain}.ts`; `src/metrics.ts`: Unit through before emit plus CLASSES through before CODE_CLASSES; `src/protocol.ts`: scratch-mount comment through before errorText.
- Infrastructure/Workers substitute: Type-only outbound/session state/identity/protocol/MCP/tool-files imports→media/types; HTTP→errors; metrics→observability; local media cross-imports retained; remaining source imports direct. Observability writes metricLine to console and AnalyticsEngine. Metrics prefix includes module sink and metricService state, so is not entirely pure despite banner. Node crypto randomBytes, Buffer encodings/PCM/WAV, Date.now, console, fetch streams and timeout remain.
- Difficulty: Needs other interfaces (bounded outbound fetch, file store, holds/usage, Log/Metrics/Clock), byte codecs. Formatting/validation first; provider/network/audio stream orchestration later.
- Copies (`backends/workers/src/` unless noted):
  - `media/images.ts` (419 lines): `IMAGE_SIZES`, `IMAGE_QUALITIES`, `IMAGE_FORMATS`, `ImageSize`, `ImageQuality`, `ImageFormat`, `ImageOptions`, `InputImage`, `GeneratedImages`, `ImageTokens`, `ImageCredentials`, `ImagePrice`, `ImageProvider`, `ImageFailed`, `transient`, `filtered`, `safetyRefusal`, `IMAGE_MODEL`, `OUTPUT_TOKENS`, `INPUT_IMAGE_TOKENS`, `CONTENT_TYPES`, `EXTENSIONS`, `openaiImages`, `checkedImage`, `imageOptions`, `ImagerOptions`, `Generated`, `Imager`, `Hold`, `ImageSource`, `ImageRequest`, `ImageService`, `imageRequest`, `fetchImage`, `GENERATE_IMAGE`, `generateImage`.
  - `media/transcription.ts` (234 lines): `Transcript`, `TranscriptionOptions`, `TranscriptionCredentials`, `TranscriptionProvider`, `TranscriptionFailed`, `EXTENSIONS`, `TRANSCRIPTION_MODEL`, `openaiTranscription`, `LanguageRefused`, `checkedAudio`, `languageInput`, `TranscriberOptions`, `Transcribed`, `Transcriber`, `TranscriptionRequest`, `TranscriptionService`, `transcribeRequest`, `fetchAudio`.
  - `media/speech.ts` (183 lines): `SPEECH_MODEL`, `SPEECH_RATE`, `SPEECH_LIMITS`, `DEFAULT_VOICE`, `SpeechInput`, `SpeechCredentials`, `SpeechProvider`, `SpeechFailed`, `openaiSpeech`, `SynthesizerOptions`, `SpeechChoice`, `Synthesizer`.
  - `media/speech-api.ts` (195 lines): `SpeechFormat`, `SPEECH_FORMATS`, `SpeechService`, `SpeechRequest`, `wavHeader`, `speechRequest`, `speechInput`, `speechChoiceInput`, `object`, `providersInput`, `voicesInput`, `voicedProviders`.
  - `media/voice-providers/tts.ts` (132 lines): `TTS_PROVIDERS`, `DEFAULT_TTS_MODELS`, `DEFAULT_VOICES`, `ttsReference`, `TtsEndpoints`, `speechProvider`, `Request`, `streamed`, `usable`, `elevenlabsSpeech`, `cartesiaSpeech`, `deepgramSpeech`.
  - `media/voice-providers/tts-chain.ts` (118 lines): `SpeechMember`, `Served`, `SPEECH_CHAIN`, `PcmLevel`, `chainedSpeech`.
  - `media/files-policy.ts` (9 lines): `scratchMount`.
  - `metrics-policy.ts` (131 lines): `errorText`, `Unit`, `Value`, `sink`, `metricService`, `setMetricService`, `setMetricSink`, `metricLine`, `CLASSES`, `REFUSED`, `errorClass`, `safeError`, `IDENTIFIER`, `postgresFacts`.
- Total copies: **1,421 lines**.

## reuse-model-policy.mjs

- Source/extraction: Whole `src/{pi-catalog,azure-openai,catalog,deepseek-replay,model-stream,tool-choice}.ts` and `clients/history-formats.ts`; additional slices detailed below.
- Infrastructure/Workers substitute: Pi catalogs retained; fs tool-streaming JSON read becomes inline JSON; SEARCH_PROVIDERS inline from web-search; imports redirected to sibling generated model policies; buggify→always false and reachable→no-op, timer.unref removed. output-validation replaces TypeBox validator calls with pi-schema compile/check and supplies TextEncoder-based jsonWithinLimit. Default model policy retains process.env/NodeJS.ProcessEnv; Azure catalog logging remains console.error; stream timers and Date.now defaults remain.
- Difficulty: Mixed: catalog/routing/shape policy nearly pure after Config and static-data split; stream needs Clock and scheduling, environment adapter stays host; Pi packages require dependency audit for neutral bundling.
- Copies (`backends/workers/src/` unless noted):
  - `model-catalog.ts` (258 lines): `piCatalog`, `ADDED`, `added`, `piModel`, `BEDROCK`, `ANTHROPIC_ID`, `PROFILES`, `PRICES`, `AZURE`, `MAX_TOKENS`, `limited`, `priced`, `AZURE_PLACEHOLDER_URL`, `corrected`, `OPENROUTER_HOSTS`, `OPENROUTER_IGNORED_HOSTS`, `OPENROUTER_HOST_VARIANTS`, `hostVariant`, `openRouterHosts`, `openRouterIgnoredHosts`, `withOpenRouterHosts`, `getModel`, `reasoningFloor`, `withCatalogPrices`, `getModels`, `ModelCompat`, `temperatureRefusal`, `callSettings`.
  - `azure-policy.ts` (135 lines): `AzureOpenAI`, `AZURE_REALTIME_MODEL`, `DEFAULT_DEPLOYMENTS`, `AZURE_API_VERSION`, `azureOpenAIConfig`, `azureRealtimeDeployment`, `azureRealtimeCredentials`, `DEPLOYMENT`, `deploymentMap`, `chatDeployments`, `AZURE_CHAT_API_VERSION`, `azureChatCredentials`, `azureCredentials`.
  - `default-model-policy.ts` (55 lines): `DEFAULT_VIRTUAL_MODEL`, `configuredModel`, `FALLBACKS`, `catalogModel`, `defaultModels`.
  - `catalog-policy.ts` (115 lines): `SEARCH_PROVIDERS`, `FETCH_PROVIDERS`, `SPEECH_PROVIDERS`, `NOT_API_KEY`, `ProviderInfo`, `ModelInfo`, `MEASURED`, `toolCallStreaming`, `models`, `usableEndpoint`, `listProviders`, `providerInfo`, `openRouterApi`, `modelInfo`, `listModels`.
  - `model-policy.ts` (276 lines): `RunLimits`, `AgentConfig`, `MIN_CONTEXT_TOKENS`, `openRouterApi`, `DEFAULTS`, `UNKNOWN_LEVELS`, `COMPLETIONS_URL`, `Passthrough`, `passthroughModel`, `VIRTUAL_PROVIDER`, `VIRTUAL_MODELS`, `VirtualSelection`, `ModelRouteReason`, `Physical`, `virtualMember`, `virtualChain`, `virtualModel`, `virtualModelReferences`, `modelReference`, `currentModel`, `same`, `routeModel`, `EndpointModel`, `ModelEndpoint`, `ModelEndpoints`, `UPSTREAMS`, `lookup`, `CustomModel`, `CUSTOM_APIS`, `CustomProvider`, `CustomProviders`, `DEFAULT_MAX_OUTPUT`, `CATALOG_FOR`, `customModel`, `endpointModel`, `resolveModel`, `RESERVED_HEADERS`, `modelHeadersInput`, `runLimitsInput`, `maxOutputTokensInput`, `temperatureInput`, `dataCollectionInput`, `modelSettingsRefusal`.
  - `history-policy.ts` (84 lines): `AgentMessage`, `validFileRef`, `CompactionState`, `HISTORY_BYTES`, `invalid`, `isObject`, `inputBlock`, `validateInitialMessages`, `NO_USAGE`, `complete`, `importedHistory`.
  - `deepseek-policy.ts` (73 lines): `REASONING_REPLAY_REFUSAL`, `DEEPSEEK_ID`, `COMPLETIONS`, `refusedReasoningReplay`, `deepseekOnOpenRouter`, `deepseekTarget`, `callId`, `deepseekContext`.
  - `model-stream.ts` (145 lines): `buggify`, `reachable`, `StreamTimeouts`, `STREAM_TIMEOUTS`, `LONG_THINKING`, `streamTimeouts`, `STALLED`, `isStalled`, `Stall`, `watchedStream`.
  - `history-formats.ts` (210 lines): `HistoryFormat`, `ImportMessages`, `HistoryFormatError`, `Block`, `Source`, `isObject`, `NO_USAGE`, `API`, `dataImage`, `outputBlocks`, `parseArguments`, `Builder`, `anthropicImage`, `anthropic`, `openaiParts`, `outputImage`, `responses`, `chat`, `toPiMessages`.
  - `output-policy.ts` (43 lines): `forcedToolChoice`, `OUTPUT_TOOL`, `OUTPUT`, `OUTPUT_INSTRUCTIONS`, `OUTPUT_REMINDER`.
  - `provider-policy.ts` (103 lines): `FETCH_PROVIDERS`, `SEARCH_PROVIDERS`, `RESERVED`, `endpoint`, `ProviderInput`, `ProviderAuth`, `CACHE_MS`, `MAX_PROVIDERS`, `MAX_MODELS`, `aad`, `invalid`, `COMPAT`, `providerName`, `model`, `providerInput`, `shownModel`.
  - `output-validation.ts` (76 lines): `jsonWithinLimit`, `validators`, `validator`, `SUBSCHEMAS`, `SCHEMA_MAPS`, `checkable`, `DETAILED_ERROR_BYTES`, `compiles`, `OUTPUT_SCHEMA_BYTES`, `outputInput`, `schemaAccepts`.
- Total copies: **1,573 lines**.

## reuse-fs-shim.mjs

- Source/extraction: Not src/: `git show ${FS_SHIM_REF ?? "origin/main"}:sandbox/v8-exec/src/pi-glue.js`, substring `const fileTool =` through before `const shim =`.
- Infrastructure/Workers substitute: Generator executes git; only encoded FS tool shim is retained, wrapped in FS_SHIM string with globalThis fs/require assignment. Pi execution/replay/discovery excluded; tool-backed fs uses own UTF-8/base64 helpers and Uint8Array.
- Difficulty: Pure script payload with separate codemode ABI; do not pretend this is an ordinary src core module. Hand-written wrapper remains Workers integration.
- Copies (`backends/workers/src/` unless noted):
  - `../codemode/fs-shim.ts` (3 lines): `FS_SHIM`.
- Total copies: **3 lines**.

### Model slice source boundaries and ownership

- `default-model-policy.ts`: `src/model.ts` beginning through before “Models whose provider” comment: `DEFAULT_VIRTUAL_MODEL`, `configuredModel`, `FALLBACKS`, `catalogModel`, `defaultModels`.
- `model-policy.ts`: `src/protocol.ts` `MIN_CONTEXT_TOKENS`; `src/catalog.ts` `openRouterApi` through before `modelInfo`; `src/openrouter-model.ts` `DEFAULTS` through before `Endpoint`; whole `src/virtual-models.ts` minus imports; `src/session-config.ts` beginning at “What a model on a tenant”, plus `ModelEndpoint` block, `UPSTREAMS` block, `resolveModel` through before `configurationRefusal`. Top-level generated RunLimits/AgentConfig declarations are handwritten.
- `history-policy.ts`: `src/history.ts` imported-compaction comment through before `validateUserMessages`; handwritten `AgentMessage`/`validFileRef` shapes replace imports.
- `output-policy.ts`: whole `src/tool-choice.ts`, plus `src/system-prompt.ts` `OUTPUT_TOOL` through before `applicationInstructions`.
- `provider-policy.ts`: `src/catalog.ts` `FETCH_PROVIDERS`, `src/web-search.ts` `SEARCH_PROVIDERS`; `src/key-scopes.ts` `RESERVED_HEADERS` through before AWS-region comment (renamed `RESERVED`) and `endpoint` through before runtime-endpoint comment; `src/model-providers.ts` `ProviderInput` through before row mapper, with `shownModel` and `MAX_PROVIDERS` made public.
- `output-validation.ts`: `src/tool-policy.ts` compiled-schema comment through before `namesFile`; `jsonWithinLimit` replacement is handwritten rather than extracted from limits.


## `reuse-money-metrics.mjs` — 134 generated lines

Sources: `src/metrics.ts` selects exactly `recordEventMetrics` and `deliveryLine` by AST; `src/limit-hits.ts` is copied whole. The generated declarations below include the added `metricService` and local `console` adapter. Swaps `WebhookEvent` to `webhook-policy.ts`, `errorClass`/`metricLine` to `metrics-policy.ts`, `emit` to `money-metrics.ts:emitSourceMetric`, service name to `workers`, and the limit-hit console log sink to `money-metrics.ts:writeMetricLine`; HTTP error helpers come from `errors.ts`. Retains per-process maps/WeakSet and default `Date.now()` in limit-hit deduplication. **Needs Clock and Metrics/Log; state must be scoped to a host instance.**

| Generated copy | Lines | Declarations (and member signatures for whole-file copies) |
| --- | ---: | --- |
| `money-event-metrics.ts` | 73 | `metricService`, `recordEventMetrics`, `deliveryLine` |
| `money-limit-metrics.ts` | 61 | `console`, `Hit`, `REFUSALS`, `said`, `hits`, `minute`, `limitHit`, `creditOf`, `creditRefused`, `limitRefused` |

## `reuse-money.mjs` — 1,617 generated lines

Sources: full `src/credit-holds.ts`, `src/workspaces.ts`, `src/model-attempts.ts`, `src/model-attempt.ts`, `src/model-attempt-stream.ts`, `src/platform-pricing.ts`, `src/pi-catalog.ts`, `src/webhooks.ts` (renamed `webhook-policy.ts`) and `src/pi-harness/tokens.ts` (renamed `money-tokens.ts`). Also extracts `FETCH_APIS` and `callFetch` from `src/compaction.ts`, and only the request-estimation statements of `explicitKeyStream` between `const input = () =>` and `const call =` into the generated wrapper `estimateModelAttempt`; it checks that `src/protocol.ts:PERSISTENCE_FAILED` occurs verbatim in the handwritten `money-host.ts` but does not generate that host module. Whole-file means every declaration and method, including the private helpers listed below, is copied.

Swaps `db.ts` to `postgres.ts`, HTTP errors to `errors.ts`, and `node-context`, limits/metrics, protocol, outbound, client-session state and Pi agent-core types to `money-host.ts`; webhook imports point at `webhook-policy.ts`. `money-host` supplies `{sleep}` and `{fetch}` factories, serializable usage types, `PERSISTENCE_FAILED`, an outbound shape, and forwards metric/limit sinks. `model-call-fetch` instead uses `account-network.ts:network`. It retains Node hash/HMAC/random APIs, `Buffer`, `Date.now`, native timers and `process.env.AGENT_MAX_RUN_SECONDS`, and the account usage buffers/caches plus webhook scan lifecycle. **Pure subparts:** pricing/token estimates/catalog. **Needs Sql, Clock, Config, Metrics/Log, async Web Crypto and outbound services:** holds, attempts, workspaces and delivery. **Tangled with ECS-only state:** process-wide timer/background reconciliation and account aggregation wiring; hosts must own invocation/lifecycle before these whole copies disappear.

| Generated copy | Lines | Declarations (and member signatures for whole-file copies) |
| --- | ---: | --- |
| `workspaces.ts` | 78 | `WorkspaceKind`, `Workspace`, `view`, `Workspaces`, `AttributedUsage`, `applyWorkspaceUsage`; methods: `constructor`, `list`, `get`, `create`, `update`, `current`, `validate`, `assign`, `memberships`, `members` |
| `model-attempts.ts` | 400 | `zero`, `hash`, `uuid`, `HOLD_OUTPUT_TOKENS`, `ATTEMPT_STALE_MS`, `INITIAL_OUTPUT_TOKENS`, `MIN_OUTPUT_TOKENS`, `CHARS_PER_TOKEN`, `Metered`, `ASK_AHEAD_TOKENS`, `lines`, `affordable`, `callCost`, `ModelAttempts`; methods: `constructor`, `event`, `persistEvent`, `hold`, `creditHold`, `progress`, `settle`, `drain`, `reconcile`, `check` |
| `model-attempt.ts` | 39 | `ModelAttemptEvent`, `Superseded`, `AttemptEstimate`, `AttemptAck`, `CreditStop`, `ModelAttemptHook`, `attemptAck`, `END_USER_CREDIT` |
| `model-attempt-stream.ts` | 119 | `RENEW_MS`, `UsageSink`, `zeroUsage`, `attemptStream` |
| `platform-pricing.ts` | 104 | `Usage`, `count`, `isSubscriptionProvider`, `catalogModel`, `dearest`, `catalogRates`, `UNPRICED_COST`, `unpricedCost`, `catalogCost`, `costAt`, `usageMissing`, `platformUsage` |
| `pi-catalog.ts` | 258 | `piCatalog`, `ADDED`, `added`, `piModel`, `BEDROCK`, `ANTHROPIC_ID`, `PROFILES`, `PRICES`, `AZURE`, `MAX_TOKENS`, `limited`, `priced`, `AZURE_PLACEHOLDER_URL`, `corrected`, `OPENROUTER_HOSTS`, `OPENROUTER_IGNORED_HOSTS`, `OPENROUTER_HOST_VARIANTS`, `hostVariant`, `openRouterHosts`, `openRouterIgnoredHosts`, `withOpenRouterHosts`, `getModel`, `reasoningFloor`, `withCatalogPrices`, `getModels`, `ModelCompat`, `temperatureRefusal`, `callSettings` |
| `webhook-policy.ts` | 395 | `EVENT_TYPES`, `EventType`, `WebhookEvent`, `UsageEvent`, `Receiver`, `Endpoint`, `MAX_ENDPOINTS`, `CLAIM_BATCH`, `LEASE_MS`, `TIMEOUT_MS`, `MAX_AGE_MS`, `ROTATION_MS`, `newSecret`, `aad`, `eventId`, `webhookEvent`, `enqueueEvents`, `usageCost`, `usageEvent`, `signedHeaders`, `eventsInput`, `descriptionInput`, `ENDPOINTS_CHANNEL`, `Subscribers`, `RUN_EVENTS`, `endpointView`, `Webhooks`, `delivery`; methods: `constructor`, `runs`, `forget`, `changed`, `checkUrl`, `list`, `get`, `create`, `update`, `delete`, `rotate`, `usageWebhook`, `setUsageWebhook`, `rotateUsageWebhook`, `deleteUsageWebhook`, `setBy`, `start`, `stop`, `send`, `kick`, `sendFrom`, `usageReceiver`, `endpointReceiver`, `receiverOf`, `backlog`, `deliver` |
| `money-tokens.ts` | 90 | `calculateContextTokens`, `getAssistantUsage`, `ContextUsageEstimate`, `estimateContextTokens`, `ESTIMATED_IMAGE_CHARS`, `estimateTextAndImageContentChars`, `estimateTokens`, `safeJsonStringify` |
| `model-call-fetch.ts` | 63 | `FETCH_APIS`, `callFetch` |
| `model-estimate.ts` | 12 | `estimateModelAttempt` |

## `reuse-openapi.mjs` — 124 generated lines

Source `src/openapi.ts`: concatenates the range `export type Parameter` up to `/** A spec's text`, `export function checkDocument` up to `/** An operation as the agent sees it`, and `export function formEncode` up to `/**\n * A response as an MCP result`. The table enumerates every extracted declaration. No infrastructure substitution: loading a spec, HTTP execution and response conversion are excluded. Uses only URL/encoding, collections and data operations. **Pure.**

| Generated copy | Lines | Declarations (and member signatures for whole-file copies) |
| --- | ---: | --- |
| `openapi-policy.ts` | 124 | `Parameter`, `Operation`, `Api`, `METHODS`, `READ_ONLY`, `MAX_DESCRIPTION`, `RESULT_BYTES`, `checkDocument`, `REF_DEPTH`, `NODE_BUDGET`, `Budget`, `deref`, `lookup`, `isJson`, `isForm`, `isMultipart`, `toolName`, `operations`, `serverUrl`, `formEncode` |

## `reuse-reset-policy.mjs` — 24 generated lines

Sources `src/pi-durable/reset.ts`: ranges `/** The most history` up to `/**\n * The context`, and ``/** The last `count` `` up to `export type ContextReset`; `src/pi-harness/messages.ts`: the two compaction-summary constants before `CompactionSummaryMessage`. Replaces runtime `AgentMessage` with `type AgentMessage = Message` from Pi AI (type-only); removes durable context and reset execution. **Pure**, with a structural message shape or already approved Pi type dependency; no host services.

| Generated copy | Lines | Declarations (and member signatures for whole-file copies) |
| --- | ---: | --- |
| `reset-policy.ts` | 24 | `AgentMessage`, `RESET_KEEP_MAX`, `RESET_SUMMARY_MAX`, `defaultResetSummary`, `keptTail`, `COMPACTION_SUMMARY_PREFIX`, `COMPACTION_SUMMARY_SUFFIX` |

## `reuse-run-policy.mjs` — 272 generated lines

Sources: `src/metrics.ts` from `CLASSES` up to the error-log comment; `src/model-stream.ts:STALLED` and `isStalled`; whole `src/model-errors.ts`; `src/compaction.ts:modelKeyFailure`; the single approval-instructions expression from `src/system-prompt.ts` inside generated `approvalPrompt`; system-prompt ranges from `FILE_RULES` up to `What the agent works with` and `runtimeRules` up to `The context's first system message`; `src/client-sessions/tools.ts:fileToolsFor` before `toolset`.

Swaps model-errors imports to generated error-classification, stream-failure and `deepseek-policy` files; prompt imports `sender-markers.ts:SENDER_INSTRUCTIONS`; narrows `AgentConfig` to `{codeMode?, tools}` and `ToolDefinition` to generated `FileToolDefinition`. No network, SQL, process or runtime loops are copied. The table includes generator-added wrappers/types. **Pure** classification/prompt/tool-selection pieces. `modelKeyFailure` consumes a failure value rather than performing host work.

| Generated copy | Lines | Declarations (and member signatures for whole-file copies) |
| --- | ---: | --- |
| `model-error-classification.ts` | 44 | `CLASSES`, `REFUSED`, `errorClass` |
| `model-stream-failure.ts` | 3 | `STALLED`, `isStalled` |
| `model-errors.ts` | 116 | `MODEL_INTERRUPTED`, `MODEL_ERROR_CLASSES`, `ModelErrorClass`, `ModelFailure`, `API_CLASSES`, `apiErrorClass`, `providerStatus`, `Failed`, `FailureContext`, `retriesModelError`, `modelFailure`, `isImageRejection`, `isModelUnavailable`, `isContentFilterBlock` |
| `model-key-failure.ts` | 6 | `modelKeyFailure` |
| `tool-approval-prompt.ts` | 5 | `approvalPrompt` |
| `prompt-policy.ts` | 94 | `AgentConfig`, `FILE_RULES`, `RESULT_RULES`, `APPLICATION_FOLLOWS`, `runtimeInstructions`, `directInstructions`, `bareInstructions`, `bare`, `INSTRUCTIONS`, `APPLICATION`, `RUNTIME`, `ENVIRONMENT`, `CODEMODE`, `LANGUAGE`, `OUTPUT_TOOL`, `OUTPUT`, `OUTPUT_INSTRUCTIONS`, `OUTPUT_REMINDER`, `applicationInstructions`, `runtimeRules` |
| `file-tool-policy.ts` | 4 | `FileToolDefinition`, `fileToolsFor` |

## `reuse-schedules.mjs` — 40 generated lines

Source `src/scheduler.ts`: range from `Schedule` before `Deliver` (includes `ScheduleEmail`/`scheduleEmail`), `RETRY_DELAYS_MS` before `COLUMNS`, `nextOccurrence` before the parse comment, and `scheduleInput` through EOF. Imports zod and directly imports `calendarInput`, `nextCalendar`, `Calendar` from `../../../src/calendar.ts`; exports private `nextOccurrence` and `retryable`. Excludes scheduler SQL, claiming, delivery and timer lifecycle. Retains `Date.now()` as overridable `now` defaults. **Pure** calendar/input/retry rules; no Clock is required where callers already pass time. The calendar file is already shared by path, so moving it under core is a small proof independent of deleting this scheduler generator.

| Generated copy | Lines | Declarations (and member signatures for whole-file copies) |
| --- | ---: | --- |
| `schedule-policy.ts` | 40 | `Schedule`, `ScheduleEmail`, `scheduleEmail`, `RETRY_DELAYS_MS`, `retryable`, `MIN_REPEAT_SECONDS`, `nextOccurrence`, `scheduleInput` |

## `reuse-security.mjs` — 2,054 generated lines

Sources and slices: full `src/accounts.ts`, `tenants.ts`, `key-scopes.ts`, `model-providers.ts`, `browser-tokens.ts`, `key-check.ts`, plus whole `deepseek-replay.ts` as `security-deepseek.ts`. `session-config.ts` contributes `EndpointModel` through before `lookup` and `CustomModel` through before `What a model replies at most`; `compaction.ts` contributes `FETCH_APIS`. `catalog.ts` contributes `Page renderers` through before `ModelInfo`, and `const models` through before `modelInfo`; `web-search.ts` contributes `SEARCH_PROVIDERS`. `outbound.ts` contributes `BLOCKED_V4` through before the `Outbound` class (with generated `Cidr`), the `OutboundBlocked` class, `Outbound.fetch` method rewritten as `guardedFetch`, and `capped`. `identity.ts` contributes `AgentIdentity`, `identityInput`, `actorInput`; `end-user-credits.ts` contributes `BUCKET_NAME`, `bucketInput`; `client-sessions/spend.ts` contributes `spendInput`; `http.ts` contributes `errorFields`, `errorHeaders`; `db.ts` contributes exactly `AUTH_FAILED`, `UNAVAILABLE_CODES`, `UNAVAILABLE_MESSAGES`, `databaseRetryable`, `RERUN_CODES`, `RETRYABLE_CODES`, `TRANSACTION_ATTEMPTS`, `databaseUnavailable`, `transaction`, `transactionOnce`. `api-schemas.ts` contributes `SEND_KEY`, `KeyInput`, `TenantInput`, `TenantLimitsInput`, with `.openapi()` annotations removed by AST transform.

Swaps DB/error imports to Workers `postgres.ts`/`errors.ts`; AWS federation/Azure options and file/secret readers to `security-host.ts` (the file/secret functions throw and require bound tenant JSON); session/model declarations to `security-types`; account usage types to `money-host`; direct pricing/limits imports remain from `src/`; catalog to `key-catalog`; outbound services to `security-outbound`; shared browser protocol to `shared/client-protocol.ts`. Catalog uses Workers `pi-catalog` and `security-deepseek`. Address parsing retains `node:net:isIP`. `guardedFetch` uses native fetch against `this.reachable(url)` instead of Undici/network dispatchers, with `Response` replacing `UndiciResponse`. Transaction logic gets sleep from `money-host`, Math.random jitter and a no-op `sometimes`; release closes a per-operation socket when `client.close` exists, else calls `release(broken)`.

Retains Node encryption/hash/random/HMAC/timing-safe APIs, Buffer, process.env/NodeJS.ProcessEnv in tenant environment loading, Date.now/cache state, account aggregation timers, and transaction connection hooks. **Mixed:** schemas/classification/deepseek/catalog data are pure; key scopes/providers/accounts need Sql plus crypto/outbound/clock/config; tenant file/AWS loading and account timer/flush ownership are ECS-tangled. Transactions require callback Sql, rollback, rerun option and one connection. Whole accounts copy also contains billing; splitting authentication from money is prerequisite to deleting this generator.

| Generated copy | Lines | Declarations (and member signatures for whole-file copies) |
| --- | ---: | --- |
| `accounts.ts` | 735 | `Principal`, `KeySource`, `KeyStatus`, `ApiToken`, `Sealed`, `GithubUser`, `GoogleUser`, `Totals`, `Charge`, `Batch`, `batch`, `sha256`, `validTenant`, `zero`, `add`, `COMPACTION`, `TRANSCRIPTION`, `IMAGE`, `SPEECH`, `DECISION`, `COMPUTER`, `TOKEN_CACHE_MS`, `SPEND_CACHE_MS`, `AZURE`, `Accounts`, `applyUsageRows`; methods: `constructor`, `exists`, `identity`, `authenticate`, `forget`, `tenantForGithub`, `adminTenantForGithub`, `tenantForGoogle`, `createEmailTenant`, `storedKeys`, `usesPlatformKeys`, `providerKey`, `apiKey`, `keyStatus`, `keyedProviders`, `ownProviders`, `platformKey`, `azureDeployment`, `hasKey`, `setKey`, `seal`, `unseal`, `deleteKey`, `listTokens`, `createToken`, `revokeToken`, `recordUsage`, `recordUsageIn`, `usageCommitted`, `quoteModelUsage`, `invalidateModelUsage`, `collectUsage`, `recordActive`, `charge`, `scheduleFlush`, `amount`, `pendingCharges`, `flushUsage`, `flushPending`, `flushReceipts`, `apply`, `monthSpend`, `spendLimit`, `runLimit`, `usage` |
| `tenants.ts` | 308 | `Tenant`, `sha256`, `validTenantId`, `Tenants`, `validEndpoints`, `tenantsFromEnvironment`, `singleTenant`; methods: `constructor`, `reload`, `parse`, `set`, `authenticate`, `has`, `github`, `linkedByLogin`, `byGithubId`, `byGithubLogin`, `maxAgents`, `maxWatchers`, `maxDefinitions`, `maxDiscordServers`, `maxVoiceSessions`, `runLimits`, `codeLimits`, `decisionConcurrency`, `internal`, `rateLimit`, `maxMonthlyCost`, `maxStorageBytes`, `billing`, `usesPlatformKeys`, `modelEndpoints`, `platformKey`, `platformProviders`, `providers`, `apiKey` |
| `key-scopes.ts` | 163 | `ScopeEntry`, `ScopeStatus`, `CACHE_MS`, `validScope`, `aad`, `invalid`, `RESERVED_HEADERS`, `AWS_REGION`, `BEDROCK`, `checkScope`, `endpoint`, `reachableEndpoint`, `scopeEntry`, `KeyScopes`; methods: `constructor`, `set`, `delete`, `status`, `entry`, `forgetProvider`, `forget` |
| `model-providers.ts` | 218 | `ProviderInput`, `ProviderAuth`, `CACHE_MS`, `MAX_PROVIDERS`, `MAX_MODELS`, `aad`, `invalid`, `COMPAT`, `providerName`, `model`, `providerInput`, `shownModel`, `Row`, `ProviderCredentials`, `authOf`, `typeOf`, `ModelProviders`; methods: `constructor`, `set`, `delete`, `deleteScope`, `list`, `resolvable`, `has`, `credentials`, `visible`, `forget`, `rows` |
| `browser-tokens.ts` | 135 | `BROWSER_SCOPES`, `DEFAULT_SCOPES`, `BrowserScope`, `BROWSER_REDACTIONS`, `INTERNAL_EVENTS`, `BROWSER_TOKEN_SECONDS`, `PREFIX`, `BrowserClaims`, `BrowserTokens`, `COST`, `withoutCost`, `readableMessage`, `readableFrame`, `readableRequest`; methods: `constructor`, `mac`, `mint`, `carries`, `verify` |
| `key-check.ts` | 40 | `CHECK_ORDER`, `KeyCheck`, `checkProviderKey` |
| `security-types.ts` | 43 | `EndpointModel`, `ModelEndpoint`, `ModelEndpoints`, `UPSTREAMS`, `CustomModel`, `CUSTOM_APIS`, `CustomProvider`, `CustomProviders`, `FETCH_APIS` |
| `key-catalog.ts` | 65 | `SEARCH_PROVIDERS`, `FETCH_PROVIDERS`, `SPEECH_PROVIDERS`, `NOT_API_KEY`, `ProviderInfo`, `models`, `usableEndpoint`, `listProviders`, `providerInfo`, `openRouterApi` |
| `security-deepseek.ts` | 74 | `REASONING_REPLAY_REFUSAL`, `DEEPSEEK_ID`, `COMPLETIONS`, `refusedReasoningReplay`, `deepseekOnOpenRouter`, `deepseekTarget`, `callId`, `deepseekContext` |
| `security-addresses.ts` | 64 | `Cidr`, `BLOCKED_V4`, `BLOCKED_V6`, `addressBytes`, `cidr`, `within`, `BUILT_IN`, `MAPPED`, `embedded` |
| `security-fetch-policy.ts` | 54 | `OutboundBlocked`, `guardedFetch`, `capped`; methods: `constructor` |
| `security-policy.ts` | 38 | `AgentIdentity`, `identityInput`, `actorInput`, `BUCKET_NAME`, `bucketInput`, `spendInput` |
| `admission-errors.ts` | 18 | `errorFields`, `errorHeaders` |
| `postgres-policy.ts` | 74 | `random`, `sometimes`, `AUTH_FAILED`, `UNAVAILABLE_CODES`, `UNAVAILABLE_MESSAGES`, `databaseRetryable`, `RERUN_CODES`, `RETRYABLE_CODES`, `TRANSACTION_ATTEMPTS`, `databaseUnavailable`, `transaction`, `transactionOnce` |
| `security-inputs.ts` | 25 | `SEND_KEY`, `KeyInput`, `TenantInput`, `TenantLimitsInput` |

## `reuse-source-input.mjs` — 9 generated lines

Source `src/tool-sources.ts`: exact range `const sameOrigin =` up to `/** What callers see of a server:` gives `sameOrigin`, `tenantAudience`, `ownAudience`, `audienceOf`; single-line `const mcpToolName =` is added. Converts `const` declarations to exported constants, otherwise unchanged. URL origin/audience/name policy only. **Pure**.

| Generated copy | Lines | Declarations (and member signatures for whole-file copies) |
| --- | ---: | --- |
| `source-input-policy.ts` | 9 | `sameOrigin`, `tenantAudience`, `ownAudience`, `audienceOf`, `mcpToolName` |

## `reuse-spend-policy.mjs` — 26 generated lines

Sources `src/client-sessions/state.ts:SpendLimit`; `src/client-sessions/spend.ts` range starting the `spendLimit` input comment before `How long an end user's charge`, plus `dollars`; `src/client-sessions.ts` method `agentSpendLimit` before `The agent's spend limit, read once per load` is converted to `agentSpendMessage(id, spend)` with the `this.spendOf(session)` read removed and session ID replaced by argument. Extracts four exact SQL strings from client-sessions query calls: clear `delete from agent_spend_limits where agent = $1`, set `insert into agent_spend_limits (agent, usd, spent, set_at)...`, read `select usd, spent, set_at from agent_spend_limits where agent = $1`, write `update agent_spend_limits set spent = spent + $2 where agent = $1 and set_at = $3`. These are emitted as `AGENT_SPEND_SQL`. HTTP errors import Workers `errors.ts`. **Pure** parsing/message/SQL strings; execution remains a **Sql** host concern.

| Generated copy | Lines | Declarations (and member signatures for whole-file copies) |
| --- | ---: | --- |
| `agent-spend-policy.ts` | 26 | `SpendLimit`, `spendInput`, `dollars`, `agentSpendMessage`, `AGENT_SPEND_SQL` |

## `reuse-sql.mjs` — 1,207 generated lines

Source `src/billing.ts`: range `export async function postLedger` before `BillingOptions` yields `postLedger` and `accrueUsage`; class method `spendable` before `Whether a prepaid tenant` is placed inside generated `BillingSpendable`. `LedgerKind`, `LEDGER_KINDS`, `LedgerEntry`, `UsageCharge`, `HOUR`/`MINUTE`, the wrapper class and its default pricing/options fields are generator-written scaffolding, not copied declarations. Full `src/end-user-credits.ts` is also copied, with all declarations and methods listed below. Swaps Sql/Db/transaction to `postgres.ts`, errors to `errors.ts`, imports pricing directly from `../../../src/pricing.ts`; end-user webhook import stays `./webhooks.ts` (Workers has adapter/re-export). Retains Node randomUUID, Buffer.byteLength, Date.now and console diagnostics in credits. **Needs Sql** with atomic transactions, event enqueueing, Clock and cryptographic IDs. Monetary ordering/idempotency/holds make this high-risk; do after auth and shared storage boundary.

| Generated copy | Lines | Declarations (and member signatures for whole-file copies) |
| --- | ---: | --- |
| `billing-sql.ts` | 83 | `LedgerKind`, `LEDGER_KINDS`, `LedgerEntry`, `UsageCharge`, `HOUR`, `postLedger`, `accrueUsage`, `BillingSpendable`, `MINUTE`; methods: `spendable` |
| `end-user-credits.ts` | 1124 | `MAX_LOT_MS`, `MICROS`, `DEFAULT_BUCKET`, `MAX_AMOUNT`, `BUCKET_NAME`, `ALLOWANCE_KEY`, `END_USER_ID`, `ENTRY_KINDS`, `EntryKind`, `LedgerKind`, `Allowances`, `EndUserSettings`, `DEFAULT_SETTINGS`, `BALANCE_CAUSES`, `BalanceCauseKind`, `BalanceCause`, `LedgerEntry`, `BucketDay`, `LEDGER_KINDS`, `LedgerQuery`, `UsageQuery`, `EndUserUsage`, `DaysQuery`, `EndUserDay`, `MAX_DAYS`, `dayAfter`, `dayInput`, `bucketInput`, `endUserInput`, `amountInput`, `allowancesInput`, `mergeKeys`, `allowanceFor`, `bucketLimitFor`, `keyedFor`, `marked`, `unmarked`, `utcDay`, `settingsView`, `entryView`, `lockEndUser`, `Lot`, `expireLots`, `lotKey`, `lotsOf`, `EndUserCredits`, `LAST_CALL_SHORTFALL`, `lastCallMin`, `HOLD_MS`, `CreditHold`, `creditError`, `CreditRefusal`, `CREDIT_REASONS`, `CreditReason`, `Hold`, `Reserved`, `Room`, `dayText`, `dollars`, `room`, `split`, `refusal`, `Posted`, `NOTHING_POSTED`, `settleUsage`, `appendEntry`, `LotMove`, `moveLots`, `ENTRY_EVENTS`, `thresholdOf`, `balanceNotices`, `thresholdChanged`, `exhausted`, `refused`; methods: `constructor`, `settings`, `setSettings`, `list`, `get`, `update`, `ledger`, `usage`, `days`, `post`, `markLot`, `expireDue`, `enabled`, `reserve`, `extend`, `hold`, `renew`, `release`, `refusal`, `charge`, `settleHold` |

## `reuse-tool-calls.mjs` — 61 generated lines

Source `src/tool-servers.ts`: range `toolCallKey` before the MCP progress comment; `src/tool-sources.ts`: `approvalFor` before `Whether a source`. The table lists all copied declarations; `ToolCall`, `ApprovalMode` and `ApprovalPolicy` are narrowed generator-written types. No host substitutions beyond types, but `node:crypto:createHash` remains for synchronous key hashing. **Pure** metadata/deadlines/approval; hash needs an async Web Crypto implementation or caller-supplied digest before entering core.

| Generated copy | Lines | Declarations (and member signatures for whole-file copies) |
| --- | ---: | --- |
| `tool-call-policy.ts` | 61 | `ToolCall`, `toolCallKey`, `callMeta`, `TOOL_DEADLINES`, `ToolErrorCode`, `ToolError`, `ToolCallCode`, `RunToolCall`, `ToolFailure`, `timedOut`, `declaredTimeout`, `ApprovalMode`, `ApprovalPolicy`, `approvalFor`; methods: `constructor` |

## `reuse-tool-output.mjs` — 32 generated lines

Source nested `src/agent-host.ts` functions `capped` before `Save large results` and `cappedDetails` before `Bytes of the results`. Encloses them in generated `toolOutputPolicy(config, saveToolResult)`; imports `SANDBOX_LIMITS`/`FILE_LIMITS` directly from src and `AGENT_UPDATES` from `sender-markers.ts`. Retains `node:buffer:Buffer` for UTF-8 byte sizing. Replaces closed-over runtime state by explicit `{fileTools?, id?}` plus async save callback. **Needs a small save-result interface**; caps are pure after using TextEncoder. No Sql/network/runtime loop required.

| Generated copy | Lines | Declarations (and member signatures for whole-file copies) |
| --- | ---: | --- |
| `tool-output-policy.ts` | 32 | `toolOutputPolicy` |

## `reuse-volume-policy.mjs` — 193 generated lines

Source `src/volumes.ts`: ranges `CHUNK_BYTES` before the data-text comment, `VOLUME_LIMITS` before the snapshot comment, `labelsInput` before `chunkKey`, `normalizePath` before the version-precondition comment, `validVolumeId` before `newId`. Source `src/files.ts`: `essence` before the download comment, `safeName` before the inline-image comment, and `LinkGrant` through EOF. These yield all declarations listed below, including content-type sniffing and `FileLinks` signing. Changes only HTTP errors to `errors.ts`; retains direct src limits, `node:buffer`, `node:util:TextDecoder`, and Node HMAC/timingSafeEqual. **Pure** path/labels/type/sniff/headers after TextEncoder/TextDecoder changes; **needs crypto/key configuration and time** for signed grants. Object storage, volume SQL and file IO are excluded.

| Generated copy | Lines | Declarations (and member signatures for whole-file copies) |
| --- | ---: | --- |
| `volume-policy.ts` | 56 | `CHUNK_BYTES`, `READ_ALL_LIMITS`, `ARCHIVE_LIMITS`, `VOLUME_LIMITS`, `LABEL_LIMITS`, `labelsInput`, `normalizePath`, `parentOf`, `nameOf`, `within`, `relativeTo`, `globRegex`, `validVolumeId` |
| `file-policy.ts` | 137 | `essence`, `validContentType`, `GENERIC_TYPES`, `genericType`, `declaredType`, `EXTENSIONS`, `textual`, `guessContentType`, `starts`, `ascii`, `sniffContentType`, `INLINE`, `downloadHeaders`, `safeName`, `LinkGrant`, `FileLinks`; methods: `constructor`, `mac`, `sign`, `verify` |

## `reuse-web-policy.mjs` — 733 generated lines

Sources: whole `src/web-search.ts`, `x-search.ts`, `web-render.ts`; `src/capabilities/router.ts` ranges `A provider's key` before `The key a tenant` and `The first provider` before `Record a call`. `src/builtins.ts` contributes single-line `FETCH`, the `DEFINITIONS` entries from `x_search` before `schedule`, `builtinDefinitions` before `searchProviders`, and `webFetch` through EOF. `src/outbound.ts` contributes `Cidr` through before the `Outbound` class plus `blocked` before `Every address`, wrapped in `PublicAddressPolicy` with generated empty block/allow arrays. `src/files.ts` contributes `textual`; `src/tool-files.ts` contributes `readCapped` and `download` before `One tool call`.

Swaps outbound/session-state imports to `web-policy-host.ts`, error metrics to `policy-host.ts`, router to `capability-router.ts`; pricing/html-text/limits remain direct src imports. Handwritten `web-policy-host` supplies narrowed usage, outbound, file-save, builtin context/services, `jsonResult`, and transfer re-exports. Retains Buffer in transfer, node:net:isIP for address parsing, `process.env` provider configuration, `Date.now` freshness defaults and console.error rendering diagnostics. **Pure** routing/definitions/budgets/address predicates after host address parser; **needs Config, Log and outbound/file-save services** for provider requests/render/fetch. Keep DNS/reachability and dispatcher restrictions in host, preserving SSRF checks across redirects.

| Generated copy | Lines | Declarations (and member signatures for whole-file copies) |
| --- | ---: | --- |
| `web-search-policy.ts` | 296 | `SearchResult`, `SearchQuery`, `FRESHNESS`, `Freshness`, `SearchProvider`, `SearchRequest`, `SEARCH`, `MIN_EXCERPT`, `SearchHit`, `withinBudget`, `SEARCH_PROVIDERS`, `SearchProviderId`, `unlink`, `text`, `pageText`, `day`, `PERIOD_DAYS`, `since`, `json`, `braveSearch`, `exaSearch`, `parallelSearch`, `firecrawlSearch`, `searchProvidersFromEnvironment`, `SEARCH_NAMES`, `webSearchUnavailable`, `searchOrder`, `WebSearchOptions`, `WebSearch`; methods: `request`, `results`, `key`, `price`, `constructor`, `search`, `attempt` |
| `x-search-policy.ts` | 98 | `X_SEARCH`, `xSearchUnavailable`, `XSearchOptions`, `object`, `count`, `handles`, `date`, `XSearch`; methods: `key`, `constructor`, `search` |
| `web-render-policy.ts` | 74 | `RENDER`, `isShell`, `WebRenderOptions`, `WebRender`; methods: `key`, `constructor`, `render` |
| `capability-router.ts` | 52 | `KeyedCredential`, `Attempt`, `httpAttempt`, `route`; methods: `constructor`, `key`, `attempt`, `exhausted` |
| `web-definitions.ts` | 39 | `FETCH`, `DEFINITIONS`, `builtinNames`, `builtinDefinitions` |
| `web-fetch-policy.ts` | 42 | `webFetch` |
| `public-address-policy.ts` | 107 | `Cidr`, `Resolve`, `OutboundPolicy`, `exactOrigin`, `BLOCKED_V4`, `BLOCKED_V6`, `addressBytes`, `cidr`, `within`, `BUILT_IN`, `MAPPED`, `embedded`, `PublicAddressPolicy`; methods: `blocked` |
| `web-transfer-policy.ts` | 25 | `textual`, `readCapped`, `download` |
