# Ops dashboard

The team's dashboard, the admin site (`src/admin-site.ts`), is at **https://run.camelai.com/ops**. It shows who
signs up and stays, what they use, the money, and whether the platform is healthy. It reads the runtime's own
database (and, for acquisition and the Journeys tab, the operator's journey store) and changes nothing. Cloudflare
Access signs the team in. Every answer of its API is logged with the email of the person who asked.

It has five tabs:

- **Growth**: sign-ups, activation, weekly active and returning accounts, the funnel, weekly cohorts, and where
  sign-ups came from.
- **Usage**: model responses by day and model, the models and features agents use, what accounts set up, the top
  accounts and agents, and one account in detail.
- **Revenue**: credit purchases and refunds, what accounts hold, what was charged against what it cost, and free
  credit.
- **Health**: what the platform pays providers, a projection of the month, and checks of the runtime's queues and
  jobs.
- **Journeys**: the earlier reports by calendar day: Product signals, Run pages and User journeys.

Growth, Usage, Revenue and Health cover the last 7, 30 or 90 UTC days (`?days=`, 1 to 365, ending today) and compare
each figure with as many days before.

## Where it is served

The site is the path `/ops` of `run.camelai.com`: `/ops` redirects (308) to `/ops/`, and `/ops/...` is the site's.
Everything else on `run.camelai.com` is the runtime's, as before, and `agents.camelai.dev` does not serve the site.
The page's scripts and styles load from the console's public `/console/assets/*` (the console's open-source code,
no data). Every figure comes from `/ops/api/*`, and every request there needs Cloudflare Access's token. The tab
icon is the camel on red (`#D03B3B`), so the dashboard is easy to tell from the console.

**Who may use it.** The admins are whoever the Access application "camelRun admin" admits: its policy must list
only them, not all employees. Access signs them in with Google Workspace. The runtime checks every request's
`Cf-Access-Jwt-Assertion` itself: an RS256 signature by the team's keys, the team as issuer
(`AGENT_ADMIN_ACCESS_TEAM`), the application's AUD tag as audience (`AGENT_ADMIN_ACCESS_AUD`), and its expiry. A
request without a valid token gets 401, however it reached the load balancer.

Under a path, the dashboard shares an origin with the console: a script that ran anywhere on run.camelai.com while an
admin is signed in to Access could ask for its figures. Nothing known does: tenants' HTML, SVG and other active files
download as attachments in a CSP sandbox (`src/files.ts`), the console's CSP allows only its own scripts, and the
dashboard's API refuses requests another site's page makes (`Sec-Fetch-Site`). A hostname of its own
(`AGENT_ADMIN_URL=https://admin.example.com`) keeps the dashboard apart from the console altogether.

**Settings** ([configuration](configuration.md)): `AGENT_ADMIN_URL=https://run.camelai.com/ops`,
`AGENT_ADMIN_ACCESS_TEAM` and `AGENT_ADMIN_ACCESS_AUD`. The URL is https, a hostname, and either no path or `/ops`
or `/admin`, names the runtime never routes. A hostname of the runtime's own
(`AGENT_PUBLIC_URL`'s or an alias's) needs a path: without one the runtime refuses to start, since the site would
take the whole name. A hostname of its own may be the site's whole, with no path; the older `AGENT_ADMIN_HOST` also
names one. On the Terraform deployment these come from `admin_hostname` (default `run.camelai.com`), `admin_path`
(default `/ops`), `admin_access_team` and `admin_access_aud` (`infra/terraform/admin.tf`).

## Deployment

The dashboard was at `admin.camelai.dev`, a hostname of its own. Moving it to `run.camelai.com/ops`:

1. **Add the destination in Cloudflare Access.** Zero Trust → Access → Applications → **camelRun admin** → edit →
   add a public hostname: `run.camelai.com`, path `ops` → save. Keep the same application, so its AUD tag
   (`admin_access_aud`), which the runtime checks, does not change. Its policy ("camelRun ops admins", used by this
   application only) lists the admins' exact addresses; after changing who is on it, revoke the application's
   existing sessions (Access → Applications → camelRun admin → Revoke existing tokens), since a session lasts until
   it expires.
2. **Apply Terraform** as [the infrastructure runbook](../../infra/terraform/README.md#plan-and-apply) says: fetch
   `prod.auto.tfvars` (it must not set `admin_hostname` or `admin_path`, or must set them to `run.camelai.com` and
   `/ops`), set `admin_emails` in it to the same addresses as the Access policy (they are kept there, not in this
   repository), plan, and read the plan. It should change only the task definition (`AGENT_ADMIN_HOST` gives way to
   `AGENT_ADMIN_URL=https://run.camelai.com/ops`, and `AGENT_ADMIN_EMAILS` appears) and destroy `admin.camelai.dev`'s CNAME, its certificate's
   validation record, the certificate and its listener certificate. Apply that plan. A plan with a runtime hostname
   and an empty `admin_path` fails, as the runtime would.
3. **Deploy** an image with the ops dashboard: `infra/ecs-deploy.sh` (or `infra/ecs-deploy.sh <tag>`).
4. **Check**: open https://run.camelai.com/ops, sign in, and see the tabs load; the log has `admin_*_viewed` lines
   with your email. https://run.camelai.com/console still works. To change the admins later, change the Access
   policy and `admin_emails` together, apply, and revoke the application's existing sessions.
5. **Remove `admin.camelai.dev`** from the Access application's destinations. After the apply it no longer
   resolves.

The order is safe either way. An image from before the ops dashboard does not know `AGENT_ADMIN_URL`: given it with
the two Access settings and no `AGENT_ADMIN_HOST`, it refuses to start, and the deployment's circuit breaker rolls
the deployment back while the running tasks keep serving. So deploying the new settings with an older image, or
rolling back to one later, fails visibly instead of taking `run.camelai.com` for the site. If the runtime serves
`/ops` before Access covers it, the site answers 401 to everyone: safe, but nobody can use it until step 1 is done.
To turn the site off, set `admin_hostname = ""`; that is also how to run an older image again.

## Connecting the journey store

The Growth tab's acquisition panel, the Journeys tab, and first-run counts in Product signals need journey events
on. On the Terraform deployment:

1. Follow [the infrastructure plan/apply instructions](../../infra/terraform/README.md#plan-and-apply): fetch the current production `prod.auto.tfvars` from the state bucket, initialize, save and inspect the plan, and apply that exact plan. Never plan from repository defaults alone: that can disable unrelated production features. This creates two empty secrets, `<secret_prefix>/journey` and `<secret_prefix>/journey-report`, lets the tasks read them, and sets the journey settings (`journey.tf`; `journey_url` is the store's origin). Nothing changes yet: with no value in the journey secret the runtime leaves journey events off.
2. Deploy (`infra/ecs-deploy.sh <tag>`), so tasks carry the new settings.
3. `infra/journey.sh <event secret file> <report secret file>` stores the two values and rolls the service. They must be the same two values the store holds as its event secret and its report secret, and they must differ from each other.

After the roll, verify healthy new tasks and check that the log no longer says `journey_not_configured`. Confirm the Journeys tab's Run pages answer. Reconcile a known new signup and first execution against the store to verify delivery; configuration alone is not proof of live collection. First-run counts cover accounts created from that moment; earlier accounts are not backfilled.

The journey store's reports also need the sales site's read-only `/api/journey/admin-report` endpoint and reporting
indexes (and, for Run pages, D1 migration `0007_page_report_indexes.sql`), with the matching `JOURNEY_REPORT_SECRET`
on the sales Worker. The report secret must be separate from event and erasure credentials. See
[configuration](configuration.md) and [privacy](privacy.md#journey-events).

## Temporary collection setting

The **Journey collection** GitHub Actions workflow changes only
`AGENT_JOURNEY_COLLECT_UNKNOWN` on a copy of the running production task definition
and rolls out the same image using the existing production deployment role.
`true` records first-party visits without an answer; `false` restores the
requirement for an explicit grant. Explicit refusals and Global Privacy Control
remain excluded in both modes. No event is relabeled as granted, and Google
Analytics still requires its own explicit grant.

Keep the sales site's `JOURNEY_COLLECT_UNKNOWN` and automatic-prompt setting in
step. The workflow preserves all unrelated runtime settings, secrets and roles.
It is a temporary runtime override: before the next Terraform apply, set
`journey_collect_unknown` to the chosen value in the production `prod.auto.tfvars`
downloaded from S3 and upload the updated file as described in the infrastructure
runbook. Otherwise that apply can restore the previous setting.

## What every tab counts

- **Days** are UTC days, the days `usage` is kept by. A window of `days` days ends today, which is still going
  (`incomplete_date`); usage reaches the database in batches, so today's figures rise during the day. The tiles
  compare the window with the `days` days before it.
- **Self-serve accounts** are tenants someone made by signing in with GitHub or Google, or by an email sign-up.
  **Operator-made accounts** have a `tenants` row but no such identity (`POST /v1/tenants`). **Admin tenants**
  (`operator`) are entries of the [tenants file](tenants.md), such as camelBot's `camel-bots`, and have no `tenants`
  row.
- **Counted accounts** are self-serve accounts that are not being or already erased and are not staff. **Staff** are
  accounts journey events marked internal, and accounts whose Google address or password address is at one of
  `AGENT_JOURNEY_INTERNAL_EMAIL_DOMAINS`. The site reads that setting even where journey events are off. Staff who
  sign in only with GitHub are counted until journey events mark them.
- An account **did work** on a UTC day when its agents got at least one model response that day (a `usage` row of a
  model's responses, as Usage counts them), whoever started the run (a person, a schedule or a channel). Compactions,
  web searches and standalone transcriptions or images (`/v1/transcriptions`, `/v1/images`) are not work, nor is
  opening the console.
- Credit amounts are micro-USD in the API (shown as dollars). Costs are USD.

## Growth

`GET /api/growth`, from the runtime's own tables, counting only counted accounts (`src/admin-growth.ts`).

- **Sign-ups**: counted accounts made in the window, by UTC day and by how they signed up (GitHub, Google or email).
- **Activated**: of the window's sign-ups, those that did work at any time up to now. The previous figure is the
  same for the previous window's sign-ups, which have had longer to activate.
- **Weekly active**: counted accounts that did work in the last 7 whole UTC days (today not included), and in the 7
  days before those. **Weekly returning**: of those, the accounts made before the 7 days.
- **Accounts**: counted accounts now. The daily line is the running total by sign-up date; accounts erased since are
  not in it.
- **Active by day**: counted accounts that did work that day, split into new (made that day) and returning (made
  before it).
- **Funnel** of the window's sign-ups, each step a subset of the one before: signed up; made an agent (any agent,
  deleted or not, or a model response); ran a model (did work at any time); came back (did work on a UTC day after the one
  it signed up on). The previous window's funnel is beside it.
- **Median days to first run**: of the window's sign-ups that did work, the median of whole UTC days from the
  sign-up day to the first day of work.
- **Cohorts**: the last 12 weeks (Monday to Sunday, UTC). For each week, its counted sign-ups and, for that week and
  each week since, how many of them did work in it.

### Acquisition

`GET /api/acquisition` (`src/admin-acquisition.ts`) reads where the window's sign-ups came from in the journey
store's `journeys` report: the accounts active in the window's UTC days, with what the store knows of each one's
first arrival. The runtime keeps none of this itself. It reads at most 20 pages of 25 accounts, for at most 15
seconds; past that, `truncated` is true and the counts are of the accounts read.

- **Tracked sign-ups**: accounts the store says signed up in the window. The store knows only the sign-ups journey
  events told it of: none from a browser that refused to be measured (nor, unless
  `AGENT_JOURNEY_COLLECT_UNKNOWN=true`, from one that gave no answer), and none from before journey events were on.
  So this is usually fewer than the Growth tab's sign-ups. Staff are left out only as far as the store leaves them
  out.
- **Sources**: each sign-up by its first arrival's source and medium. "No browser (API or MCP)" is an account made
  without a browser; "Not captured" is one with no recorded source. For each source: sign-ups, how many have a first
  completed run in the store (`activated_at`, at any time), and how many made a payment the store recorded in the
  window.
- **Campaigns** and **landing pages**: the ten with the most sign-ups.
- **Coverage**: the times of the store's first and last events, so a window before them reads as unknown, not none.

`status` is `not_configured` where no journey store answers reports here (no `AGENT_JOURNEY_URL` or report
secret), and `unavailable` where it could not be asked just now; the counts are then empty.

## Usage

`GET /api/usage` (`src/admin-usage.ts`). A **model response** is a `usage` row of a model's response to an agent's
turn: not a compaction, transcription, image, web search, page render or tool search. Admin tenants are kept apart
from self-serve accounts throughout, so camelBot's traffic never hides or inflates customers'.

- **Responses by day**, split three ways: self-serve (counted accounts), operator (admin tenants, camelBot among
  them), and other (operator-made accounts, staff and erased accounts).
- **Active accounts**: counted accounts with a model response in the window.
- **Responses**: model responses of every account, and of counted accounts alone.
- **Agents ran**: distinct agents that called a model in the window, of every account and of counted accounts. This
  comes from `model_attempts` (each call to a provider, so a failed call counts), and includes stateless runs'
  sessions and sub-agents.
- **End users**: distinct end users (account and `subject`) of model calls metered by
  [end-user credits](../guides/end-user-credits.md), which is how camelBot meters its people. Calls without end-user
  credits name no end user, so only accounts that turned them on have any.
- **`attempts_since`**: the first model attempt recorded. Agents ran, end users and the top agents count only from
  then, and the page says so when the window reaches back further.
- **Live agents**: agents now that are not deleted or expired, and are not a stateless run's session or a child a
  delegate call made, of every account and of counted accounts.
- **Models**: the 15 with the most responses in the window: responses and distinct accounts, of every account and
  of counted accounts, and `usage.cost` (the provider cost of the calls, whoever's key they were on).
- **Configured models**: the models live agents are set to now.
- **Features**: live agents that use web search, read web pages, MCP servers, OpenAPI tools, their app's own tools, a
  schedule, a channel, sub-agents, asking a person, image making, a definition, or have code mode off.
- **Integrations**: accounts that set up each channel type, their own model keys or model server, an MCP client, run
  webhooks, trace export, end-user credits, volumes or voice calls, of every account and of counted accounts. Erased
  accounts are left out. **MCP clients**: the 12 client names most accounts connected to the hosted MCP endpoint.
- **Top accounts**: the 100 accounts with the most model responses in the window, of any kind, staff and erased ones
  marked: live agents, cost, `platform_cost`, active days, last active day, top three models, balance and credit
  bought.
- **Top agents**: the 25 agents with the most model calls in the window (`model_attempts`), with their account, kind
  (agent, stateless run or child), end users, active days and last call.

### One account

`GET /api/account?tenant=<id>` is the drill-down from a top account or agent: who the account is (its GitHub login,
Google address or password address, kind, staff or erased, billing mode), its balance, credit bought (net of refunds)
and free credit given; its model responses, cost and platform cost in the window, by model and by day; its channels
(type and name); how many API keys, definitions, volumes and schedules it has; the providers it keeps its own key for;
and the MCP clients it connected.

It also lists up to 50 live agents, the most used first. For each: name, type, model, definition, built-ins, the
**hosts** of its MCP servers (never the path or query, which can carry a credential), how many OpenAPI sources and
app tools it has, whether code mode is on, schedules, its channel, model calls, end users and last call in the
window, and **the first 1,500 characters of its system prompt**, with the whole prompt's length. Before the prompt is
cut, what looks like a credential is hidden, keeping its first four characters (`sk-a…[hidden]`): provider, GitHub,
Slack, Discord, AWS and Stripe keys, this runtime's `art_` tokens, webhook secrets, bearer tokens, JWTs and private
keys (`maskSecrets`). A secret in no such form still shows: the excerpt is customer text. Each view is logged
as `admin_account_viewed` with the viewer's email, the tenant and the days ([privacy](privacy.md#the-ops-dashboard)).
An id the runtime knows nothing of answers 404.

## Revenue

`GET /api/revenue` (`src/admin-revenue.ts`). Staff are left out; erased accounts' purchases are in, being money that
came in.

- **Revenue**: credit purchases in the window (Checkout and automatic top-ups), at the credit bought. The checkout fee
  and Stripe's fees are not in it, and refunds are not taken off. **Refunds**: refunds in the window.
- **Buyers**: accounts that bought in the window. **First purchases**: accounts whose first purchase ever was in it.
- **Paying accounts**: prepaid accounts that have bought credit, net of refunds. **Automatic top-up**: accounts with
  it switched on and not paused (no card, an expired card, or its monthly limit reached).
- **Credit held**, now, across prepaid accounts: credit bought and not spent, and free credit not spent. An account's
  balance is one pool, and **free credit counts as spent first**: of a balance, the part up to what the account
  bought is bought credit, and only the rest is free. (The console says the same when an account is deleted.)
- **By day** in the window, and **by month** for the last 12 UTC calendar months: purchases, amount, refunds, buyers.
- **Charged and cost** in the window, for accounts that have bought credit and accounts that have not: what they were
  charged (`usage` and `storage` entries in the ledger: model calls, agent hours, tools, storage), and what their
  calls cost the platform (`usage.platform_cost`, prepaid accounts). An account is paying or not by whether it has
  bought credit now, not when it was charged.

### Free credit

Of counted prepaid accounts that were given free credit (a starting grant, a card check's grant, or a positive
adjustment by an operator):

- **Given**, **used** and **left**, with left as above (free credit counts as spent first), and how each got it
  (`via`: GitHub, card, operator).
- **Buckets** by the share used: untouched (under a cent used), tried (under a quarter), using (a quarter to three
  quarters), nearly out (three quarters or more, with a cent or more left) and used up (under a cent left).
- **Used any** (not untouched) and **bought** (have bought credit, net of refunds, at any time).
- **Without**: counted prepaid accounts given no free credit, and the starting-credit decisions recorded for counted
  prepaid accounts (eligible, ineligible, disabled, legacy) and card checks that granted credit
  ([billing](billing.md)).
- **Provider cost**: what the calls of counted prepaid accounts that never bought credit have cost the platform, all
  time: what free credit costs.
- **Accounts**: up to 200, the most used first.

## Health

`GET /api/health` (`src/admin-health.ts`).

### Spend

**Spend is `usage.platform_cost`**: what the platform pays model and tool providers for calls on its own keys, in USD.
For model calls through the platform's OpenRouter key it includes the cost of funding OpenRouter credit
(`AGENT_OPENROUTER_CREDIT_MULTIPLIER`, 1.055 by default). Calls on accounts' own keys and model servers are not the
platform's spend; their model responses are counted apart (`own_key_responses`, against `platform_responses`).
Every account's calls count here, admin tenants' and staff's included.

- **Window**: spend in the window and the window before.
- **This month**: the UTC month so far; a **projection**: the month through yesterday, plus the last 7 whole days'
  daily average for today and each day left; and last month's whole.
- **By day**, by what it was for: models, compaction, web (web search and page renders), tool search, voice
  (transcription), images.
- **By payer**: paying (accounts that bought credit), free (prepaid, never bought), operator (admin tenants), unbilled
  (accounts that are not charged: not prepaid) and staff.
- **By provider** (the first part of the model id: `openrouter`, `openai`, `anthropic`, `brave`, ...) and the 10
  accounts that cost the most.

### Checks

Each check reads the runtime's own tables. Work that waits longer than it should is the sign of a fault.

| Check | Looks at | Status |
|---|---|---|
| Runtime nodes | nodes whose lease is live, and which are draining | bad with none |
| Schedules on time | schedules due over 10 minutes ago that no node has claimed | bad with any |
| Schedule deliveries | schedules whose last delivery failed (they retry, then skip to the next time) | warn with any |
| Agents resuming | live agents whose interrupted run failed to resume | warn with any |
| Channel messages | channel items due over 10 minutes ago and unclaimed | warn with any; bad over 50, or with the oldest over an hour |
| Model charges settled | model calls over an hour old whose final cost the provider has not confirmed | warn with any |
| Get Help requests | requests that could not be mailed, and requests pending over an hour | bad, warn |
| Billing mail | mail failed in the last 7 days, and mail due over an hour ago | warn |
| Daily storage charge | the last UTC day the storage job charged for | warn when before yesterday; info when it never ran |
| Account deletions | deletions asked for over an hour ago and unfinished | warn with any |
| Journey events | events over an hour old the store has not taken; events it refused | warn; refused is info |
| Running now | busy agents and live voice calls | info |
| Customers' webhooks | deliveries being retried, and trace exports failing (usually the customer's endpoint) | info |

Below them, each live node: whether it is draining, the actors it holds, and when its lease expires.

## Journeys

The earlier reports, by calendar day in a time zone: today in America/Chicago by default, calendar presets
(including the last 7, 14 and 30 days, including today) or inclusive custom dates, up to 366 days. They can differ
by a day at the edges from the UTC tabs.

### Product signals

`GET /api/product-signals` reads Run's own database.

- Sign-ups are self-serve tenant creations (GitHub, Google or email). Operator-created accounts are excluded from sign-up counts.
- Activated accounts are recorded `run_first_execution_completed` milestones, not the Growth tab's "did work". Tracking records this first for accounts created since collection began whose analytics settings allow it. Counts can be unavailable or partial; the interface labels coverage and renders unknown values as a dash, not zero. Coverage is based on tracking state, not proof of uninterrupted delivery.
- Payments are purchase entries in the credit ledger, including checkout and automatic top-ups. Amounts are converted from micro-USD to cents, shown as dollars, and are gross before later refunds. Paying accounts are distinct buyers during the interval.
- These reports exclude accounts being or already erased, and staff identified by tracking (not by email domain). Unknown staff can still appear before tracking identifies them.
- Daily counts use calendar-day boundaries in the selected time zone, including daylight-saving changes. Counts are activity totals; comparing them does not yield a signup-cohort conversion rate.

### Sign-ups and returning accounts chart

`GET /api/activity-trend` gives the chart its two lines for the last 14 days (`days`, up to 90; `end_date` to end on another day): sign-ups, and returning active accounts. It reads Run's own database, so it covers every day and does not depend on journey tracking.

- A returning active account is a self-serve account made before that day whose agents received at least one model response on that day. A scheduled or channel-triggered run counts; opening the console does not. An account active on the day it signed up is counted as a sign-up, not as returning.
- **These days are UTC, not Central Time.** Run keeps usage by UTC day and holds no finer record of when an account ran, so the returning line cannot be cut at Central midnight; the sign-up line uses the same UTC days so the two can be compared. A sign-up at 8 pm Central appears on the next UTC day here and on the same Central day in Product signals.
- The current UTC day is still in progress (`incomplete_date`), so its point rises during the day.
- The same accounts are left out as in Product signals.

### Run pages

`POST /api/report` with `kind: "pages"` returns a row for the homepage, `/run` and each blog post about Run, from the sales site's journey store. The list of posts is kept in the sales site (`app/data/blog-products.ts`); a page with no recorded activity is still listed with zeros. Each row carries three separate groups of counts:

- **On the page, in the dates:** visitors, page views, and visitors who clicked through to Run. A visitor is one anonymous browser id, not a verified person.
- **Sign-ups in the dates, by first landing page:** how many of the period's sign-ups first landed on this page (whenever that first visit was), and how many of those accounts have since completed a run or paid.
- **New visitors in the dates:** browsers first seen in the dates that landed on this page, and how many of those same browsers have signed up since. Only this pair is a conversion rate; recent ranges have had less time to convert.

`signup_attribution` accounts for every tracked-store sign-up in the dates; this can differ from the database-backed Product signals total. It records whether the account first landed on a Run page, on another page, or not captured. Nothing is inferred for a sign-up with no recorded first visit. Staff browsers are excluded from both sides of the new-browser conversion fraction; identical first-touch timestamps are resolved by touch ID. Links use the report's configured sales-site host.

### User journeys

`POST /api/report` with `kind: "journeys"` lists the accounts active in the dates, and `kind: "journey"` one account's events. The store's shared-browser ownership rules determine which account owns each event. Journeys use opaque account IDs (`account_ref`); no name or email lookup is added.

The selected interval controls activity, payment counts and timeline events. Sign-up, acquisition and first activation fields describe the account's recorded lifetime history. Missing attribution stays "Not captured." Lists page 25 accounts at a time; timelines page 100 events in chronological order.

A missing journey connection does not hide the database-backed product signals. JSON reports are never cached, report secrets stay on the server, and the site limits request and response sizes, refuses redirects and times out (`src/admin-report.ts`). The store refuses oversized ranges rather than returning truncated totals.

## Known limits

- **UTC days.** Growth, Usage, Revenue and Health cut days at UTC midnight, as `usage` is kept; the Journeys tab uses
  calendar days in its time zone.
- **AWS infrastructure is not in spend.** Health's spend is what providers charge for calls on the platform's keys.
  ECS, RDS, the load balancer, S3, CloudWatch, Cloudflare, Stripe's fees and SES are not in it.
- **Per-agent figures scan `model_attempts`.** Agents ran, end users, top agents and the drill-down's per-agent calls
  read `model_attempts` by `started_at`, which has no index, so each read scans the table. The table begins with
  migration 066 (runtime 0.10.0): these figures start at `attempts_since`, the first attempt recorded.
- **Staff by GitHub alone** are counted until journey events mark them internal.
- **Paying or free is as of now.** Revenue's and Health's split of accounts uses whether an account has bought credit
  today, not when it was charged.
- **Acquisition** knows only the sign-ups the journey store recorded, and reads at most 500 accounts a request.

## API

Every endpoint is under the site's path (`/ops/api/...`), needs the Access token, and is read-only (`Cache-Control:
no-store`). Each answer but `/api/me`'s is logged with the viewer's email.

| Endpoint | What | Log line |
|---|---|---|
| `GET /api/me` | the viewer's email | |
| `GET /api/growth?days=` | Growth | `admin_growth_viewed` |
| `GET /api/acquisition?days=` | Growth's acquisition, from the journey store | `admin_acquisition_viewed` |
| `GET /api/usage?days=` | Usage | `admin_usage_viewed` |
| `GET /api/account?tenant=&days=` | one account, with its agents' prompts | `admin_account_viewed` (with the tenant) |
| `GET /api/revenue?days=` | Revenue | `admin_revenue_viewed` |
| `GET /api/health?days=` | Health | `admin_health_viewed` |
| `GET /api/stats?days=` | the original lifetime overview | `admin_stats_viewed` |
| `GET /api/product-signals` | Product signals | `admin_signals_viewed` |
| `GET /api/activity-trend` | sign-ups and returning accounts by UTC day | `admin_trend_viewed` |
| `POST /api/report` | a journey store report (`signals`, `journeys`, `journey`, `pages`) | `admin_report_viewed` |

For the tabs' endpoints and `/api/stats`, `days` is a whole number from 1 to 365 (30 by default); anything else
answers 400.

## Validation

`tests/admin-dashboard.test.ts` covers the windows, every tab's definitions (staff, erased and admin tenants, free
credit counting as spent first, spend by payer, the checks), acquisition paging, the drill-down's prompt and MCP
hosts, and the site on a path: only `/ops` and `/ops/...` are the site's, all of it needs the token, and the settings
are refused where they could not work. `tests/admin-signals.test.ts` covers the Journeys tab's reports and the
journey store proxy. `tests/admin-site.test.ts` exercises the full runtime and requires the runtime's Rust-built V8
executor.

For release acceptance, sign in through Cloudflare Access at https://run.camelai.com/ops with an admin's account and
check that an account outside the policy is refused, then reconcile a known sign-up, first run and purchase against
the source records. A local test with synthetic identities and records is not verification of production collection
or production SSO.
