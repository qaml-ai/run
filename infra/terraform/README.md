# Terraform for the hosted agent runtime

This directory describes the runtime's AWS and Cloudflare infrastructure (AWS
account `904534089871`, `us-west-2`, plus the us-east-1 alerting). The
operational scripts in `infra/` set secret values and deploy images; everything
else is here.

| File | Contents |
|---|---|
| `runtime.tf` | shared locals, the default VPC lookup, ECR repository and lifecycle policy |
| `alb.tf` | public ALB, ACM certificate (validated through Cloudflare), target group, listeners, ALB security group (ingress from Cloudflare's IPv4 ranges only) |
| `ecs.tf` | ECS cluster, Fargate service, task definition, task and execution roles, task security group, autoscaling, the RDS rule for tasks, log group |
| `rds.tf` | control-plane Postgres, its subnet group and security group |
| `state-bucket.tf` | S3 bucket for agent state and the IAM statements for it |
| `secrets.tf` | Secrets Manager containers under `camelai/agent-runtime/` |
| `dns.tf` | Cloudflare CNAME `agents.camelai.dev` to the ALB (proxied) |
| `dns-primary.tf` | `run.camelai.com`: its own ACM certificate on the HTTPS listener (SNI) and a proxied Cloudflare CNAME to the ALB in the `camelai.com` zone |
| `monitoring.tf` | Route 53 health check, `-healthz` alarm and SNS topic in us-east-1 |
| `alarms.tf` | ALB/ECS alarms and their us-west-2 SNS topic |
| `email.tf` | email channels, when `email_domain` is set: SES identity and receipt rule, DKIM/MX/DMARC records, inbound mail bucket, SNS topic and subscription, the task's send/read policy |

## Prerequisites

- OpenTofu >= 1.10 (`brew install opentofu`; the provider lock file is committed; run `tofu init`). Terraform >= 1.10 also works.
- AWS credentials for account `904534089871`. The providers refuse any other account.
- `CLOUDFLARE_API_TOKEN` in the environment with DNS edit access to `camelai.dev`
  and `camelai.com` (and zone read, to look `camelai.com` up by name). Without
  it, planning the DNS records fails.

## Plan and apply

```sh
cd infra/terraform
tofu init
tofu plan -out=tfplan
tofu apply tfplan
```

Always apply a saved plan you have read. The state bucket, the RDS instance and
the session-secret/secrets-key/tenants/github-oauth secrets have
`prevent_destroy`; Terraform refuses any plan that would delete them. The ALB
and the RDS instance also have deletion protection in AWS.

## Architecture

```text
   agents.camelai.dev, run.camelai.com  (Cloudflare CNAMEs, proxied)
                   │
                   ▼
   ALB camelai-agent-runtime   (default public subnets, 4 AZs; ingress from Cloudflare's IPv4 ranges only)
     :443  ACM certs (one per name, by SNI), TLS 1.2/1.3, idle timeout 360 s
     :80   301 to https
                   │ target group (ip) :8790, GET /healthz, deregistration 15 s
                   ▼
   ECS Fargate service camelai-agent-runtime  (ARM64, 1 vCPU / 2 GB, 2..10 tasks)
     tasks in the default subnets with public IPs (egress to model providers, no NAT)
     SG task: 8790 from the ALB and from itself (node-to-node forwarding)
     ├── RDS Postgres camelai-agent-runtime-control (5432 from the task SG)
     └── S3 camelai-agent-runtime-state/agents/*  (task role)
```

- **Only Cloudflare reaches the ALB** (`alb.tf`): its security group admits 443
  and 80 from Cloudflare's IPv4 ranges alone (read from Cloudflare at each plan,
  so a range it adds shows up as a rule to add), so nothing bypasses Cloudflare
  and the runtime takes the client's address from `CF-Connecting-IP`
  (`AGENT_TRUST_CF_CONNECTING_IP`, which its per-address rate limits key on).
  Nothing calls the ALB's own DNS name: the deploy script, the Route 53 health
  check, Stripe, SNS and the channels' webhooks all use the hostnames. To reach a
  task directly while debugging, use ECS Exec, or curl `127.0.0.1:8790` from one.
- **State bucket** (`camelai-agent-runtime-state`): versioned, all public access
  blocked, SSE-S3, ACLs disabled. Noncurrent versions expire after 30 days
  (`noncurrent_version_days`), expired delete markers are removed, and
  incomplete multipart uploads are aborted after 7 days. The task role gets
  `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `<bucket>/agents/*`,
  and `s3:ListBucket` limited to the `agents/` prefix. Conditional writes
  (`PutObject` with `If-None-Match: *` or `If-Match: <etag>`, used by
  `shared/s3-storage.ts`) need only `s3:PutObject`, so nothing more is granted.
- **Postgres** (`rds.tf`): Postgres 17, `db.t4g.small`, Multi-AZ, not public,
  7-day backups. RDS generates and rotates the master password in Secrets
  Manager (`manage_master_user_password`), so it never appears in state; the
  runtime reads it from that secret.
- **RDS Proxy** (`rds-proxy.tf`): the tasks connect through it, so a Multi-AZ
  failover is a stall (the proxy holds connections and queues statements) rather
  than dropped connections and a DNS change. It logs in with the same master
  secret (its role may read it), requires TLS, and uses the default target group
  settings. Its certificate is from ACM, so the image's CA bundle holds the
  Amazon Trust Services roots as well as the RDS CAs. The tasks' security group
  can still reach the instance directly, for debugging and manual migrations
  (`database.host` output; the proxy is `database.proxy_endpoint`). About $22 a
  month ($0.015 per vCPU-hour, 2 vCPU).
  Moving the tasks onto the proxy: deploy an image whose bundle
  trusts the proxy first (any image from this change on), set
  `runtime_image_tag` to it, apply, then redeploy that tag with
  `infra/ecs-deploy.sh <tag>` to ship the new environment.
- **Task definition** (`ecs.tf`). Settings come from `var.runtime_env`. Storage,
  database, public-URL and tenant settings are derived from the resources:
  - `AGENT_STORAGE=s3`, `AGENT_S3_BUCKET`, `AGENT_S3_PREFIX`, `AWS_REGION`;
  - `AGENT_DATABASE_HOST` (the proxy), `AGENT_DATABASE_NAME`, `AGENT_DATABASE_SECRET_ARN`, `AGENT_DATABASE_CA`;
  - `AGENT_LEASE_TTL_MS=90000`, longer than a failover keeps the database away;
  - `AGENT_PUBLIC_URL`, `AGENT_TENANTS_SECRET_ARN`;
  - `AGENT_SESSION_SECRET_ARN`, `AGENT_SECRETS_KEY_ARN`, `AGENT_GITHUB_OAUTH_SECRET_ARN`,
    `AGENT_STRIPE_SECRET_ARN` (credit purchases stay off until `infra/stripe.sh` stores its value);
  - `AGENT_TOOL_SEARCH=embeddings,jev` and `AGENT_TOOL_SEARCH_SECRET_ARN` (tools.search uses the
    platform's OpenRouter key from the tenants secret; `infra/tool-search.sh` stores a dedicated one instead).
  - `AGENT_OPENAI_APPS_CHALLENGE` from `openai_apps_challenge`, when set: the ChatGPT plugin's domain-verification
    token (`plugins/chatgpt/README.md`).

  The task definition has no `secrets`: the runtime reads every secret itself,
  through the task role, so no secret value is in its environment, where a
  sandbox child running as the same uid could read it. Session-secret,
  secrets-key, github-oauth and stripe are read once at startup; the tenants secret is
  re-read every 60 s. Logs go to `/ecs/camelai-agent-runtime`, kept for 30 days.
- **Roles**. The execution role has only `AmazonECSTaskExecutionRolePolicy`
  (ECR and logs). The task role has the state bucket statements
  (`local.state_bucket_statements`), read access to the RDS, tenants,
  session-secret, secrets-key, github-oauth and stripe secrets,
  `ecs:UpdateTaskProtection`/`ecs:GetTaskProtection` on this cluster's tasks,
  `ecs:DescribeServices` on this service, and ECS Exec. To get a shell:
  `aws ecs execute-command --region us-west-2 --cluster camelai-agent-runtime --task <id> --container agent-runtime --interactive --command sh`.
- **Scaling**. Target tracking holds average CPU at 60% and average memory at 70%,
  within `service_min_count`..`service_max_count` (2..10). Scale-in has a
  5-minute cooldown. `ecs.tf` has a commented example of scaling on an
  `AgentRuntime` EMF metric instead: `hostedAgents` (agents started per task,
  what `AGENT_MAX_AGENTS` caps), Average, dimension `ServiceName` (the task
  sets `AGENT_SERVICE_NAME`). The runtime also publishes `sessions` (agents
  loaded per task, hosted or not); `agents` is the older name of
  `hostedAgents`, kept for existing dashboards.
- **Task protection**. The runtime turns on ECS scale-in protection for its own
  task while turns are running (`AGENT_ECS_CLUSTER`, `AGENT_ECS_SERVICE` are
  set for it). Scale-in skips protected tasks, so it removes idle tasks first;
  when every task is busy, the desired count drops but the extra tasks keep
  running until their turns finish.
  - **Retiring.** A task superseded by a newer deployment keeps `/healthz` at
    200 while it finishes long turns. It takes no new actors: it forwards
    requests for anything it doesn't hold to a live peer, and releases each
    actor it holds once that actor goes idle. So the ALB may keep routing to it.
  - **Why it doesn't fail `/healthz`.** AWS documents scale-in protection as
    guarding tasks only against "scale-in events from either service auto
    scaling or deployments" ([task scale-in protection][tsp];
    `ExpiresInMinutes` is 1 to 2880, default 120). It says nothing about health
    checks. The service scheduler replaces tasks that fail ALB health checks
    as a separate mechanism ([ALB health checks for ECS][hc]), so a protected
    task that returned 503 would be killed, along with its turns.
  - **Knobs** (runtime defaults, not set by Terraform):
    `AGENT_RETIRE_MAX_MS=21600000`, `AGENT_ECS_POLL_MS=30000`,
    `AGENT_PROTECTION_IDLE_MS=30000`. `AGENT_ECS_SERVICE` is required for
    retirement. `ECS_AGENT_URI` and `ECS_CONTAINER_METADATA_URI_V4` come from
    Fargate.
  - **How long protection lasts.** `AGENT_RETIRE_MAX_MS` (6 h) bounds how long
    a task holds protection. The runtime must keep refreshing it within the
    2880-minute limit.
- **Stopping a task** (deploy, scale-in, rebalancing):
  0. If the task is protected, ECS waits until the runtime clears protection
     (its turns have finished, or `AGENT_RETIRE_MAX_MS`, default 6 h, passed).
  1. ECS deregisters the task. The ALB sends it no new requests, and its open
     connections, including SSE streams, stay up for the 15 s deregistration
     delay. After that, clients reconnect to another task. A longer delay would
     only postpone SIGTERM.
  2. ECS sends SIGTERM. The runtime drains its agents (about 100 s,
     `AGENT_DRAIN_TIMEOUT_MS` 100000, which fits `stopTimeout`), and `/healthz`
     returns 503. That's only a backstop, since the task is already
     deregistered. The container runs with `initProcessEnabled`, so an init
     is PID 1: it forwards the signal and reaps sandbox children.
  3. SIGKILL follows 120 s after SIGTERM (`stopTimeout`).

  A turn cut short by a crash or a SIGKILL is resumed by the agent's next owner.
- **Deployments** are rolling: `minimumHealthyPercent` 100 and `maximumPercent`
  200. The circuit breaker rolls back automatically if new tasks never pass
  `/healthz`. It counts failed task launches, not time, so old tasks that stay
  protected for hours never trip it. A deployment's `rolloutState` stays
  `IN_PROGRESS` until its last old task is gone: up to `AGENT_RETIRE_MAX_MS`
  (6 h) + 15 s + 120 s. The runtime notices a newer deployment and retires
  itself once idle. Don't make CI wait on `services-stable` or on
  `rolloutState = COMPLETED`; wait as `ecs-deploy.sh` does.

[tsp]: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection.html
[hc]: https://repost.aws/knowledge-center/elb-ecs-tasks-improperly-replaced

## Log retention

Every log group this stack writes to has an expiry, set here:

| Log group | Retention | What it holds |
|---|---|---|
| `/ecs/camelai-agent-runtime` (`ecs.tf`) | 30 days | runtime stdout/stderr: structured lines with ids, sizes and error codes |
| `/aws/ecs/containerinsights/camelai-agent-runtime/performance` (`ecs.tf`) | 1 day | Container Insights performance events (CPU, memory, task counts); the metrics made from them stay in CloudWatch Metrics |
| `/aws/rds/proxy/camelai-agent-runtime-control` (`rds-proxy.tf`) | 30 days | RDS Proxy connection log (connections, logins, errors; no statements, debug logging is off) |

ECS and RDS create the last two groups themselves when they are missing (1 day
and never expiring, respectively). Terraform declares them first on a new stack.
On a stack where they already exist, import them before the first apply, or the
create fails with `ResourceAlreadyExistsException`:

```sh
tofu import -var-file=prod.tfvars aws_cloudwatch_log_group.container_insights /aws/ecs/containerinsights/camelai-agent-runtime/performance
tofu import -var-file=prod.tfvars aws_cloudwatch_log_group.database_proxy /aws/rds/proxy/camelai-agent-runtime-control
```

The billing-email Worker (`infra/billing-email`) is deployed with Wrangler, not
Terraform. Cloudflare keeps Workers Logs for 7 days on the Workers Paid plan
(3 on Free), and the retention cannot be changed. It logs only a line's type;
Cloudflare's invocation logs (request metadata) are off in its `wrangler.toml`.

## Alarms

- **Route 53** (`monitoring.tf`, us-east-1): an HTTPS health check on
  `agents.camelai.dev/healthz` (by hostname, so it checks through Cloudflare and the ALB). The
  `-healthz` alarm notifies the us-east-1 topic `camelai-agent-runtime-alerts`
  (output `alerts_topic_arn`). Route 53 health check metrics exist only in
  us-east-1, so the alarm and topic live there.
- **ALB and ECS** (`alarms.tf`, us-west-2):
  - `-unhealthy-hosts`: `UnHealthyHostCount > 0` for 3 minutes;
  - `-alb-5xx`: more than 10 ALB-generated 5xx in 5 minutes;
  - `-target-5xx`: more than 25 task 5xx in 5 minutes;
  - `-running-tasks`: `RunningTaskCount` below the minimum for 5 minutes. This
    needs Container Insights.
  - `-ecs-control-errors`: at least 3 runtime log lines of type
    `task_protection_failed`, `ecs_service_check_failed` or
    `ecs_service_unavailable` in each of two 5-minute periods. A log metric
    filter on `/ecs/camelai-agent-runtime` counts them as
    `AgentRuntime/Logs` `EcsControlErrors`. Missing IAM or ECS API trouble shows
    up here: without protection, scale-in can stop busy tasks, and without the
    service check, superseded tasks never retire. ECS refusing protection to a
    task a deployment is replacing (`DEPLOYMENT_BLOCKED`) is expected while it
    drains: it is one `task_protection_blocked` line, not counted. The `retiring` and `retired`
    lines can be found with a Logs Insights query:
    `filter type in ["retiring", "retired"]`.

- **Runtime metrics** (`observability.tf`, us-west-2, namespace `AgentRuntime`),
  among them:
  - `-model-spend`: model spend, all tenants, over `spend_alarm_usd_per_hour`
    ($100) in an hour;
  - `-tenant-model-spend`: any one tenant's model spend over
    `tenant_spend_alarm_usd_per_hour` ($50) in an hour. A Metrics Insights query
    (`SELECT SUM(ModelCostUsd) … GROUP BY Tenant ORDER BY SUM() DESC LIMIT 1`)
    takes the top tenant each hour; the dashboard's cost by tenant says which;
  - `-model-billing-errors`: more than 3 model responses refused for credit in
    15 minutes (`ModelErrors`, `ErrorClass=billing`: provider 402s such as
    OpenRouter's "requires more credits, or fewer max_tokens"). On the platform
    keys this is the first sign the OpenRouter or Anthropic balance is low: it
    cannot cover a full `max_tokens` request. Top the account up. A tenant's own
    key running dry counts too.

  CloudWatch alarms can only notify a topic in their own region, so these use
  the us-west-2 topic `camelai-agent-runtime-alerts` (output
  `alerts_topic_arn_regional`). Subscribe to both topics.

## Deploying

Terraform registers the **first** task definition revision (`runtime_image_tag`).
Every later revision comes from `infra/ecs-deploy.sh`, and the service has
`ignore_changes = [task_definition, desired_count]`. That keeps Terraform from
rolling the service back to its own revision, and keeps it from fighting autoscaling.

```sh
infra/ecs-deploy.sh          # build + push this checkout, register a revision, roll, wait
infra/ecs-deploy.sh <tag>    # deploy an image already in ECR
```

The script does this:
1. Copies the family's latest revision.
2. Swaps the container image.
3. Registers the result as a new revision.
4. Runs `update-service`.
5. Waits until the new deployment's tasks are all healthy in the target group
   (at most 30 minutes). It fails if the circuit breaker rolled back or the
   rollout failed.
6. Checks `/healthz` through Cloudflare and the ALB.

It does **not** wait for the old tasks to stop. They retire in the background,
each once its running turns end (at most `AGENT_RETIRE_MAX_MS`, default 6 h),
then drain as above. The script prints the command to follow them. A deploy
interrupts no turns. Two deploys in a row are fine: a task superseded twice
retires the same way.

When Terraform changes environment or cpu/memory, it registers a new revision
with the image from `runtime_image_tag`, but the service keeps running the old
one. To ship the change, deploy the running tag: `infra/ecs-deploy.sh <tag>`.
The deploy copies Terraform's newer revision and sets the image. To see which
tag is running:

```sh
aws ecs describe-task-definition --region us-west-2 --task-definition camelai-agent-runtime \
  --query 'taskDefinition.containerDefinitions[0].image' --output text
```

Leave `runtime_image_tag` at a tag that exists. Terraform only uses it when it
registers a revision.

## History

The runtime moved from a single EC2 host to this ECS service on 2026-09-24. The
old host proxied to the ALB through Caddy while the DNS record flipped to the
ALB, and the host was removed afterwards. The full cutover runbook is in git
history.

## Monthly cost (us-west-2, on-demand, before tax)

| Item | Estimate |
|---|---|
| Fargate ARM64, 2 tasks × 1 vCPU / 2 GB (730 h) | ~$58 (each extra task ~$29) |
| Public IPv4: 2 tasks + 4 ALB addresses ($3.65 each) | ~$22 |
| ALB hour + LCUs (light traffic) | ~$22 |
| CloudWatch Logs, Container Insights, 4 alarms | ~$10 |
| **ECS runtime total at minimum** | **~$112** |

## Secrets

Terraform manages the secret **containers** only: names, descriptions, deletion
behaviour. It never reads or writes values. There is deliberately no
`aws_secretsmanager_secret_version` anywhere, so state holds no secret material.
`infra/tenant.sh` writes the tenants and operator-token values, and
`infra/github-oauth.sh` writes the GitHub OAuth value. `infra/tenant.sh add`
creates `operator-token/<tenant>` secrets. To bring a new one under Terraform,
add the tenant to `operator_token_tenants` and import its ARN (an `import {}`
block or `tofu import`).

## Remote state

State lives in `s3://camelai-terraform-state-904534089871/agent-runtime/terraform.tfstate`
(us-west-2; versioned, encrypted, public access blocked). The bucket was created
once by hand, outside this configuration. OpenTofu locks the state with a lock
object next to it (`use_lockfile`), so no DynamoDB table is needed. State holds
resource IDs and ARNs but no secret values.

## Known gaps

- Both `camelai-agent-runtime-alerts` topics have one email subscription that
  is still pending confirmation (checked 2026-09-24), so alarms reach no one
  until it is confirmed.

## Hostnames

The ALB answers to `agents.camelai.dev` (`hostname`) and `run.camelai.com`
(`primary_hostname`). `public_hostname` picks which one is `AGENT_PUBLIC_URL`,
where people are sent; the other goes in `AGENT_PUBLIC_ALIASES` and is served in
full. `AGENT_ISSUER` stays `https://agents.camelai.dev` whichever is public:
identity tokens' `iss` and the OAuth issuer name it, and tool servers (chiridion
among them) and MCP clients check it. The email channels' SNS endpoint also
stays on `hostname`. `run.camelai.com` needs the `camelai.com` zone's SSL mode
at Full (strict), since Cloudflare connects to the ALB by that name.
