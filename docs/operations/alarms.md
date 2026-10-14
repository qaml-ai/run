# Alarms

Every alarm the hosted runtime's Terraform defines, what it watches, and what to do when it fires. The definitions
are in `infra/terraform/` (`monitoring.tf`, `alarms.tf`, `observability.tf`, `ses-mail.tf`, `billing.tf`); this page
must change with them.

## Where they go

| SNS topic | Region | Alarms | Subscribers |
|---|---|---|---|
| `camelai-agent-runtime-alerts` | us-east-1 | `-healthz` only: Route 53 health check metrics exist only in us-east-1 | email |
| `camelai-agent-runtime-alerts` | us-west-2 | every other runtime alarm below | email; Slack through AWS Chatbot when `alerts_slack_*` are set (`chatbot.tf`) |
| `camelai-agent-runtime-billing` | us-west-2 | `-billing-review`, `-billing-worker-errors` | the billing Slack channel (`billing.tf`) |

CloudWatch alarms can notify only a topic in their own region, hence the two `-alerts` topics. Each alarm also
notifies when it returns to OK, except the two billing alarms. Subscribe to a topic with
`aws sns subscribe --region <region> --topic-arn <arn> --protocol email --notification-endpoint <address>`, then
confirm from the mail: a pending subscription receives nothing.

All names below start with `camelai-agent-runtime`. "Logs" means the log group `/ecs/camelai-agent-runtime`
(us-west-2); queries for it are in [Logs and metrics](logs-and-metrics.md). The dashboard
`camelai-agent-runtime-launch` has a graph for most of these.

## Availability

| Alarm | Fires when | Topic |
|---|---|---|
| `-healthz` | Route 53's HTTPS check of `agents.camelai.dev/healthz` (through Cloudflare and the ALB) fails for 3 minutes; no data counts as failing | alerts, us-east-1 |
| `-unhealthy-hosts` | a target has failed `/healthz` at the ALB for 3 minutes | alerts |
| `-running-tasks` | fewer running tasks than `service_min_count` (2) for 5 minutes (Container Insights; no data counts as failing) | alerts |
| `-alb-5xx` | over 10 load-balancer-generated 5xx (no healthy target, reset, timeout) in 5 minutes | alerts |
| `-target-5xx` | over 25 5xx from the tasks in 5 minutes | alerts |
| `-task-memory` | a task's RSS over 75% of its memory (`task_memory`, 2 GB) for 3 minutes | alerts |
| `-runs-uncertain` | 1 or more runs failed because their node stopped during them (crash, OOM, a drain out of time) in 5 minutes | alerts |
| `-ecs-control-errors` | 3 or more `task_protection_failed`, `ecs_service_check_failed` or `ecs_service_unavailable` log lines in each of two 5-minute periods | alerts |

- **`-healthz`, `-unhealthy-hosts`, `-running-tasks`.** Look at the service first:
  `aws ecs describe-services --region us-west-2 --cluster camelai-agent-runtime --services camelai-agent-runtime
  --query 'services[0].[deployments,events[:10]]'`. A deploy in progress whose new tasks fail their health check is
  rolled back by the circuit breaker; stopped tasks say why (`aws ecs list-tasks --desired-status STOPPED`, then
  `describe-tasks --query 'tasks[].[stoppedReason,containers[0].reason]'`). If tasks are fine and only `-healthz`
  fires, suspect Cloudflare or DNS: `curl -sS https://agents.camelai.dev/healthz` and `https://run.camelai.com/healthz`.
- **`-alb-5xx`, `-target-5xx`.** The runtime does not log each request, so start from the dashboard's "Load
  balancer" graph (when) and its "Runtime errors and refusals" table (which error types rose then): a
  `database_connection_error` or `heartbeat_renew_failed` rise points at the database, `self_fence` at a node that lost
  its lease. ALB 5xx alone, during a deploy, that stop by themselves are connections cut as tasks stop; a steady rate
  is a bug or a dependency (database, S3).
- **`-task-memory`, `-runs-uncertain`.** A task near its memory is about to be OOM-killed, which makes uncertain runs.
  Check the dashboard's "Task memory and CPU" and "Agents, running turns, watchers": many hosted agents on one task
  point at a tenant's burst; a steady climb at a leak. Stopped tasks with `OutOfMemoryError` confirm it. Raising
  `task_memory` is a Terraform change plus a deploy ([Deploys](deploys.md#settings-changes-ship-with-a-deploy)).
- **`-ecs-control-errors`.** The task role cannot protect its task or read its service: scale-in may stop busy tasks
  and superseded tasks never retire. Usually IAM (a changed `ecs.tf` policy) or an ECS API outage. One
  `task_protection_blocked` line while a deployment drains is expected and not counted.

## Turns and models

| Alarm | Fires when | Topic |
|---|---|---|
| `-turn-failures` | over 40% of turns failed in each of two consecutive 15-minute windows, each with at least 5 turns (`Turns` with `Outcome=failed` over all `Turns`) | alerts |
| `-first-token-slow` | p90 of `TimeToFirstTokenMs` over 60 s in three consecutive 5-minute periods | alerts |
| `-model-billing-errors` | 2 or more turns failed for credit in 15 minutes (`Turns` with `ErrorClass=billing`) | alerts |
| `-model-rate-limited` | 10 or more model responses failed for rate limits or overload in 5 minutes (`ModelErrors`, `ErrorClass` `rate_limit` plus `overloaded`) | alerts |
| `-model-spend` | model spend, all tenants, over `spend_alarm_usd_per_hour` ($100) in an hour | alerts |
| `-tenant-model-spend` | any one tenant's model spend over `tenant_spend_alarm_usd_per_hour` ($50) in an hour (Metrics Insights picks the top tenant) | alerts |
| `-quota-rejected` | 1 or more `quota_rejected` log lines in 5 minutes: agent starts refused at a tenant's or a node's agent cap | alerts |

### `-turn-failures`

A normal day fails 10-20% of turns, so this fires on a real rise: a provider down, a platform key refused, a bad
deploy.

1. The dashboard's "Failed turns by error class" says which class rose (`errorClass` in `src/metrics.ts`:
   `stream_stalled`, `provider_5xx`, `network`, `timeout`, `rate_limit`, `overloaded`, `billing`, `auth`,
   `context_overflow`, `refusal`, `runtime_restart`, `exception`, `other`). `billing` has its own runbook below.
2. Which models: the by-model query in [Logs and metrics](logs-and-metrics.md#which-models-are-slow-or-failing). One
   provider or model failing points at the provider (its status page) or at the platform's key for it; every model
   failing points at the runtime (a deploy just before? roll back, [Deploys](deploys.md#rolling-back)).
3. Which tenants: "Failed runs by tenant and class", or Logs `filter type = "run_failed" | stats count() by Tenant, ErrorClass`. One
   tenant's failures are usually its own key (`auth`, `billing`) or its own tools, and need nothing from us.

### `-first-token-slow`

Time to first token is measured per turn, from its start to the first streamed token of its model response, across
all models. A slow provider or model, retries before the first token (each retry waits and starts again), or turns
queueing on a loaded node all raise it.

1. Run the per-model query in [Logs and metrics](logs-and-metrics.md#which-models-are-slow-or-failing) over the last
   hour or three. A model whose p90 stands out, with enough turns to move the fleet's p90, is the cause; its
   `ModelRetries` and `ModelErrors` say whether it is slow or failing and being retried.
2. If no model stands out, look at the nodes: the dashboard's CPU, memory and `dbWaiting` graphs, and running turns per
   node.
3. A provider being slow is not ours to fix. If one platform model is slow for long, say so to the people whose
   agents use it (chiridion, camel-bots): they can move to another model.

### `-model-billing-errors`

A provider refused a request for credit (HTTP 402, OpenRouter's "requires more credits, or fewer max_tokens"). A turn
retries a refused response three times, so the alarm counts turns, not responses. Find whose key:

1. Logs: `filter type in ["model_error", "run_failed"] and ErrorClass = "billing"`. `model_error` names the provider
   and model, `run_failed` the tenant.
2. Logs, the same minutes: `filter type = "model_cost" and Provider = "<provider>"`. If other turns on that provider
   are still billed, one key ran dry: a tenant's own, or a chiridion organization's own key (they run under its
   tenant). Nothing on the platform needs doing.
3. If every turn on that provider fails, the platform account's balance cannot cover a full `max_tokens` request: top
   up the platform's OpenRouter or Anthropic account. Its first refusals come before the balance is zero, so act at
   once.

### `-model-rate-limited`

Providers refusing for rate or load. The free tier has no fallback model, so its users see failures. Find the model
with the by-model query; if it is one platform model, ask the provider for a higher limit or move the free tier off
that model.

### `-model-spend`, `-tenant-model-spend`

The dashboard's "Model spend by tenant" says which tenant. A runaway loop or abuse on one account: check its runs
(`GET /v1/usage` with its token, or Logs `filter type = "model_cost" and Tenant = "<tenant>"`). For an admin tenant
cap it with `infra/tenant.sh set-spend-limit <tenant> <usd>` (applies within a minute, [Tenants](tenants.md)); a
self-serve tenant is limited by its credit.

### `-quota-rejected`

A tenant or a node at its agent cap refused starts because every agent there is busy (prepaid tenants at their tier's
limit log `busy_limit_reached` instead, not counted). Logs `filter type = "quota_rejected"` say which limit: raise the
tenant's (`infra/tenant.sh set-limit`), or add tasks (`service_max_count`) if nodes are full.

## Webhooks and database

| Alarm | Fires when | Topic |
|---|---|---|
| `-webhook-failed` | 10 or more `webhook_failed` or `webhook_scan_failed` log lines in each of two 5-minute periods | alerts |
| `-webhook-lag` | the oldest undelivered webhook event waited over 10 minutes, in two consecutive 5-minute periods | alerts |
| `-database-pool-waiting` | queries waited for a database connection (`dbWaiting` above 0) for 5 minutes | alerts |
| `-database-cpu-credits` | the control database's CPU credit balance below 30 for 15 minutes | alerts |

- **Webhooks.** Deliveries retry for 3 days. Run events settle chiridion's threads and usage events bill its
  organizations, so a receiver down for long is visible to its users. Logs `filter type = "webhook_failed"` give the
  tenant, the event, the attempt and the error (`Kind` is `endpoint` for a tenant's webhook endpoints, `usage` for
  usage webhooks): a receiver's errors or timeouts are the receiver's to fix; tell its owner.
- **Database.** `-database-cpu-credits`: the `db.t4g` instance is about to be held to its baseline CPU, and every
  durable write slows; move it to a larger class (`rds.tf`, a Multi-AZ change with a short failover).
  `-database-pool-waiting`: the pool (`AGENT_DATABASE_POOL_SIZE`) is too small for the load, or the database is
  slow; check the dashboard's "Database" graphs first.

## Mail

| Alarm | Fires when | Topic |
|---|---|---|
| `-ses-bounce-rate` | SES's account bounce rate over 5% (SES reviews an account from 5% and pauses its sending at 10%) | alerts |
| `-ses-complaint-rate` | complaint rate over 0.1% (paused at 0.5%) | alerts |
| `-mail-send-failed` | any `account_mail_failed` or `billing_mail_send_failed` log line in 15 minutes | alerts |

See [Account email](account-email.md). A bounce or complaint rise usually comes from sign-ups with made-up
addresses; the rates are the whole AWS account's, so other products' mail counts too.

## Billing

| Alarm | Fires when | Topic |
|---|---|---|
| `-billing-review` | any `billing_reconciliation_required` log line in a minute | billing |
| `-billing-worker-errors` | 3 or more billing mail or automatic refill worker failures in 5 minutes | billing |

Both are runbooks in [Billing](billing.md). Returning to OK does not mean a payment was reconciled.

## Not alarmed

ECS autoscaling's own `TargetTracking-...-AlarmHigh` and `-AlarmLow` alarms (CPU and memory) drive scaling, not
people. `AlarmLow` sits in ALARM whenever the service is at its minimum, which is most of the time: that is normal.
