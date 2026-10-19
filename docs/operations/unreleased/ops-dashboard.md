### Ops dashboard

- The team's admin site is now the ops dashboard, at https://run.camelai.com/ops, with Growth, Usage, Revenue and
  Health tabs and the earlier reports under Journeys. `AGENT_ADMIN_URL` (e.g. `https://run.camelai.com/ops`: https, a
  hostname, and no path or `/ops` or `/admin`) says where it is; under a path, the hostname may be one of the
  runtime's own. Only the path (308 to it with a slash) and the paths under it are the site's; everything else on the
  hostname is the runtime's. The page's scripts and styles load from `/console/assets/`, and every data request needs
  Cloudflare Access's token, as before. `AGENT_ADMIN_HOST` still names a hostname of its own; setting both fails the
  start, as does a runtime hostname without a path. See [Ops dashboard](admin-analytics.md).
- New read-only endpoints under the site's path, each for `?days=` UTC days (1 to 365) and logged with the viewer's
  email: `GET /api/growth` (sign-ups, activation, weekly active and returning accounts, the funnel, weekly cohorts),
  `GET /api/acquisition` (where sign-ups came from, from the journey store's `journeys` report), `GET /api/usage`
  (model responses, models, features, integrations, top accounts and agents, with admin tenants such as camelBot
  kept apart from self-serve accounts), `GET /api/account?tenant=` (one account), `GET /api/revenue` (purchases,
  refunds, credit held, free credit, with free credit counted as spent first), `GET /api/health` (the platform's
  provider spend and a projection of the month, and checks of the runtime's queues and jobs) and `GET /api/me`.
  `/api/stats`, `/api/product-signals`, `/api/activity-trend` and `POST /api/report` are unchanged.
- The account drill-down shows each live agent's setup and the first 1,500 characters of its system prompt, with what
  looks like a credential hidden, and its MCP servers by host only. The dashboard's API refuses cross-site requests
  (`Sec-Fetch-Site`), takes only Access tokens with an expiry, and runs at most two of its reads at once per node. Each view is logged as `admin_account_viewed` with the viewer and the tenant
  ([privacy](privacy.md#the-ops-dashboard)).
- `AGENT_ADMIN_EMAILS` (Terraform `admin_emails`, kept in the deployment's tfvars) names the admins: anyone else
  Cloudflare Access signs in gets a 403 for all of the site, logged as `admin_site_refused`. It is a second lock beside
  the Access policy, which should list the same addresses. Unset, whoever the policy admits may use the site.
- The dashboard leaves out staff: accounts journey events marked internal, and accounts whose Google or password
  address is at one of `AGENT_JOURNEY_INTERNAL_EMAIL_DOMAINS`, which the site reads even where journey events are off.
- Hosted: Terraform's `admin_hostname` is now `run.camelai.com` and the new `admin_path` is `/ops`, passed as
  `AGENT_ADMIN_URL`. On a runtime hostname `admin.tf` makes no certificate or DNS record, so applying removes
  `admin.camelai.dev`'s, and that address stops resolving; a plan with a runtime hostname and an empty `admin_path`
  fails. Add `run.camelai.com`, path `ops`, to the "camelRun admin" Access application first, and remove
  `admin.camelai.dev` from it afterwards. An image from before this change refuses to start with the new settings,
  and the deployment circuit breaker rolls it back ([deployment](admin-analytics.md#deployment)).
