# Admin analytics

The existing admin site (`AGENT_ADMIN_HOST`) now opens with Product signals and User journeys. Its original platform overview remains available below them, with its original lifetime figures and UTC usage range. Both tracking tabs share a calendar range: today in America/Chicago by default, calendar presets or inclusive custom dates, up to 366 days. No change to customer sign-in or the regular console is required.

## Deployment requirements

Set `AGENT_ADMIN_EMAILS` (or Terraform `admin_emails`) to the intended admin addresses **before deploying**. Cloudflare Access still verifies the company identity; the runtime now also requires an explicit email allowlist for every admin page, asset and API request. Missing or empty configuration returns 503 and exposes no admin data. A valid identity outside the list receives 403; missing/invalid Access tokens receive 401. Set the company’s approved addresses in deployment configuration, not public source. The runtime's other hostnames are unaffected.

Product signals read Run's own database. The journey tab additionally requires the sales site's read-only `/api/journey/admin-report` endpoint and reporting indexes, plus `AGENT_JOURNEY_REPORT_SECRET` or `AGENT_JOURNEY_REPORT_SECRET_ARN` on Run and the matching `JOURNEY_REPORT_SECRET` on the sales Worker. The secret must be separate from event/erasure credentials. Run uses the configured `AGENT_JOURNEY_URL` as the reporting origin. See [configuration](configuration.md) and [privacy](privacy.md#journey-events). These changes do not enable collection or configure a production database automatically.

## Metric definitions

- Sign-ups are self-serve tenant creations (GitHub, Google or email). Operator-created accounts are excluded from sign-up counts.
- Activated accounts are recorded `run_first_execution_completed` milestones, not the original overview's “ran a model” count. Tracking records this first for accounts created since collection began whose analytics settings allow it. Counts can be unavailable or partial; the interface labels coverage and renders unknown values as a dash, not zero. Coverage is based on tracking state, not proof of uninterrupted delivery.
- Payments are purchase entries in the credit ledger, including checkout and automatic top-ups. Amounts are converted from micro-USD to cents, shown as dollars, and are gross before later refunds. Paying accounts are distinct buyers during the interval.
- New signal reports exclude accounts being or already erased, and staff identified by tracking. Unknown staff can still appear before tracking identifies them. The unchanged legacy overview retains its original definitions.
- Daily counts use calendar-day boundaries in the selected time zone, including daylight-saving changes. Counts are activity totals; comparing them does not yield a signup-cohort conversion rate. UTC daily usage buckets in the legacy view are not rebucketed into Central Time.

## Journey details

The store's shared-browser ownership rules determine which account owns each event. Journeys use opaque account IDs; no name/email lookup is added. The first and last parts of the ID distinguish list labels; the full ID appears in the detail panel.

The selected interval controls activity, payment counts and timeline events. Sign-up, acquisition and first activation fields describe the account's recorded lifetime history. Missing attribution stays “Not captured.” Summaries describe stored evidence rather than guessing. Lists page 25 accounts at a time; timelines page 100 events in chronological order. Date changes reset both the page and the selected account. Requests are canceled on filter changes, and a delayed old response cannot replace a newer report.

A missing journey connection does not hide the database-backed product signals. Loading, empty, erased-account and unavailable-report states are distinct. JSON reports are never cached, report secrets remain server-side, and the admin proxy limits request/response sizes, refuses redirects, and imposes a timeout. The source store refuses oversized ranges rather than returning truncated totals.

## Validation

`tests/admin-signals.test.ts` covers verified identity and allowlisting, absent configuration, host isolation, calendar boundaries, metric semantics, coverage, signatures and bounded proxy behavior. `console/test/admin-analytics.test.tsx` covers calendar validation, stale responses, pagination, dollars and access/error states. `tests/admin-site.test.ts` exercises the existing full-runtime overview and requires the runtime's Rust-built V8 executor.

For release acceptance, configure the approved allowlist, validate actual company sign-in, enable and connect the journey store when ready, then reconcile a known signup/first-run/purchase path against source records. A local test with synthetic identities and records is not verification of production collection or production SSO.
