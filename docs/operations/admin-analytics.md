# Admin analytics

The existing admin site (`AGENT_ADMIN_HOST`) now opens with Product signals, Run pages and User journeys. Its original platform overview remains available below them, with its original lifetime figures and UTC usage range. All three tabs share a calendar range: today in America/Chicago by default, calendar presets (including the last 7, 14 and 30 days, including today) or inclusive custom dates, up to 366 days. No change to customer sign-in or the regular console is required.

## Deployment requirements

The admins are whoever the Access application's policy admits. Narrow that policy to the admin addresses before enabling reports. The runtime verifies every request's Access token (team and AUD); a missing or invalid one gets 401. The runtime's other hostnames are unaffected.

Product signals read Run's own database. The journey and page tabs additionally require the sales site's read-only `/api/journey/admin-report` endpoint and reporting indexes, plus `AGENT_JOURNEY_REPORT_SECRET` or `AGENT_JOURNEY_REPORT_SECRET_ARN` on Run and the matching `JOURNEY_REPORT_SECRET` on the sales Worker. The secret must be separate from event/erasure credentials. Run uses the configured `AGENT_JOURNEY_URL` as the reporting origin. See [configuration](configuration.md) and [privacy](privacy.md#journey-events). These changes do not enable collection or configure a production database automatically.

The Run pages report also requires sales-site D1 migration `0007_page_report_indexes.sql`. Apply the reporting migrations and deploy the sales report endpoint before releasing the new Run UI.

## Metric definitions

- Sign-ups are self-serve tenant creations (GitHub, Google or email). Operator-created accounts are excluded from sign-up counts.
- Activated accounts are recorded `run_first_execution_completed` milestones, not the original overview's “ran a model” count. Tracking records this first for accounts created since collection began whose analytics settings allow it. Counts can be unavailable or partial; the interface labels coverage and renders unknown values as a dash, not zero. Coverage is based on tracking state, not proof of uninterrupted delivery.
- Payments are purchase entries in the credit ledger, including checkout and automatic top-ups. Amounts are converted from micro-USD to cents, shown as dollars, and are gross before later refunds. Paying accounts are distinct buyers during the interval.
- New signal reports exclude accounts being or already erased, and staff identified by tracking. Unknown staff can still appear before tracking identifies them. The unchanged legacy overview retains its original definitions.
- Daily counts use calendar-day boundaries in the selected time zone, including daylight-saving changes. Counts are activity totals; comparing them does not yield a signup-cohort conversion rate. UTC daily usage buckets in the legacy view are not rebucketed into Central Time.

## Sign-ups and returning accounts chart

`GET /api/activity-trend` gives the chart its two lines for the last 14 days (`days`, up to 90; `end_date` to end on another day): sign-ups, and returning active accounts. It reads Run's own database, so it covers every day and does not depend on journey tracking.

- A returning active account is a self-serve account made before that day whose agents received at least one model response on that day. A scheduled or channel-triggered run counts; opening the console does not. An account active on the day it signed up is counted as a sign-up, not as returning.
- **These days are UTC, not Central Time.** Run keeps usage by UTC day and holds no finer record of when an account ran, so the returning line cannot be cut at Central midnight; the sign-up line uses the same UTC days so the two can be compared. A sign-up at 8 pm Central appears on the next UTC day here and on the same Central day in Product signals, so the two views can differ by a day at the edges.
- The current UTC day is still in progress (`incomplete_date`) and usage reaches the database in batches, so its point rises during the day.
- The same accounts are left out as in Product signals: operator-created tenants, accounts being or already erased, and staff identified by tracking.

The frontend always requests the latest 14 UTC days independently of the shared calendar filter. Refresh reloads it. Focus or hover a day to inspect both counts, or expand the daily data table. The chart fits phone widths and identifies the current day as partial.

## Run pages

`POST /api/report` with `kind: "pages"` returns a row for the homepage, `/run` and each blog post about Run, from the sales site's journey store. The list of posts is kept in the sales site (`app/data/blog-products.ts`); a page with no recorded activity is still listed with zeros. Each row carries three separate groups of counts:

- **On the page, in the dates:** visitors, page views, and visitors who clicked through to Run. A visitor is one anonymous browser id, not a verified person.
- **Sign-ups in the dates, by first landing page:** how many of the period's sign-ups first landed on this page (whenever that first visit was), and how many of those accounts have since completed a run or paid.
- **New visitors in the dates:** browsers first seen in the dates that landed on this page, and how many of those same browsers have signed up since. Only this pair is a conversion rate; recent ranges have had less time to convert.

`signup_attribution` accounts for every tracked-store sign-up in the dates; this can differ from the database-backed Product signals total. It records whether the account first landed on a Run page, on another page, or not captured. Nothing is inferred for a sign-up with no recorded first visit. The report needs the journey connection; without it the tab shows the same "not connected" state as User journeys.

The page table can sort by visitors, attributed sign-ups, new-visitor conversion, or publication order. On phones and windows narrower than 900px each page becomes a card with labeled metrics so attributed sign-ups remain visible. Scheduled posts retain zero rows with a scheduled date. Links use the report’s configured sales-site host. Staff browsers are excluded from both sides of the new-browser conversion fraction; identical first-touch timestamps are resolved by touch ID.

## Journey details

The store's shared-browser ownership rules determine which account owns each event. Journeys use opaque account IDs; no name/email lookup is added. The first and last parts of the ID distinguish list labels; the full ID appears in the detail panel.

The selected interval controls activity, payment counts and timeline events. Sign-up, acquisition and first activation fields describe the account's recorded lifetime history. Missing attribution stays “Not captured.” Summaries describe stored evidence rather than guessing. Lists page 25 accounts at a time; timelines page 100 events in chronological order. Date changes reset both the page and the selected account. Requests are canceled on filter changes, and a delayed old response cannot replace a newer report.

A missing journey connection does not hide the database-backed product signals. Loading, empty, erased-account and unavailable-report states are distinct. JSON reports are never cached, report secrets remain server-side, and the admin proxy limits request/response sizes, refuses redirects, and imposes a timeout. The source store refuses oversized ranges rather than returning truncated totals.

## Validation

`tests/admin-signals.test.ts` covers verified identity, absent configuration, host isolation, calendar boundaries, metric semantics, coverage, signatures and bounded proxy behavior. `console/test/admin-analytics.test.tsx` covers calendar validation, stale responses, pagination, dollars and access/error states. `tests/admin-site.test.ts` exercises the existing full-runtime overview and requires the runtime's Rust-built V8 executor.

For release acceptance, configure the approved Cloudflare Access policy, validate actual company sign-in, enable and connect the journey store when ready, then reconcile a known signup/first-run/purchase path against source records. A local test with synthetic identities and records is not verification of production collection or production SSO.
