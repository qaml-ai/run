# Hosted agent runtime

Runs this service for teammates' own agents at `https://agents.camelai.dev`.

Resources (AWS account `904534089871`, `us-west-2`), mostly named
`camelai-agent-runtime`, all described in [`terraform/`](terraform/README.md):

- ECS Fargate service and cluster `camelai-agent-runtime` (ARM64, 1 vCPU / 2 GB
  per task). Autoscaling targets average CPU 60% and memory 70%, with 2 to 10 tasks.
- A public ALB with an ACM certificate. `agents.camelai.dev` is a DNS-only
  Cloudflare CNAME to it, with TTL 60.
- RDS Postgres (`camelai-agent-runtime-control`, Multi-AZ): the control plane
  (ownership leases, indexes, timers, outboxes, accounts). RDS manages and
  rotates its credentials in Secrets Manager, and the runtime reads them from there.
- S3 bucket `camelai-agent-runtime-state`, prefix `agents/`: the data plane
  (transcripts, journals, logs).
- ECR repository `camelai-agent-runtime` (immutable tags, last 30 images kept).
- Secrets Manager:
  - `camelai/agent-runtime/session-secret`: derives client session tokens.
    Rotating it invalidates every issued session token.
  - `camelai/agent-runtime/tenants`: operator token hashes and provider API keys.
  - `camelai/agent-runtime/operator-token/<tenant>`: each tenant's operator
    token, for handing to that person.
  - `camelai/agent-runtime/secrets-key`: the AES-256 key that encrypts
    provider keys tenants set themselves. Losing it makes those keys unreadable.
  - `camelai/agent-runtime/github-oauth`: the console's GitHub OAuth app
    (optional; see below).

  Tasks read session-secret, secrets-key and github-oauth by ARN at startup,
  and re-read the tenants secret every 60 s. No secret value is in the task's
  environment.
- Monitoring:
  - A Route 53 HTTPS health check on `https://agents.camelai.dev/healthz`. Its
    alarm goes to the SNS topic `camelai-agent-runtime-alerts` in us-east-1.
  - ALB and ECS alarms (unhealthy hosts, ALB 5xx, target 5xx, running tasks,
    `EcsControlErrors`) go to the topic of the same name in us-west-2.

  Subscribe to both topics:
  `aws sns subscribe --region <region> --topic-arn arn:aws:sns:<region>:904534089871:camelai-agent-runtime-alerts --protocol email --notification-endpoint <email>`

The runtime moved here from a single EC2 host on 2026-09-24. The host proxied
to the ALB through Caddy while DNS flipped to the ALB, and was then removed. Git
history has the cutover runbook.

## Scripts

- `infra/ecs-deploy.sh`: build, push and deploy (see "Deploying changes").
- `infra/tenant.sh`: tenants, operator tokens and provider keys in Secrets Manager.
- `infra/github-oauth.sh`: stores the GitHub OAuth secret, then force-rolls the ECS service.
- `infra/config.sh`: settings shared by the scripts above.

## Adding a person

```sh
infra/tenant.sh add miguel
infra/tenant.sh set-key miguel anthropic   # paste the key, then Ctrl-D
AGENT_URL=https://agents.camelai.dev \
AGENT_RUNTIME_TOKEN=$(aws secretsmanager get-secret-value --region us-west-2 \
  --secret-id camelai/agent-runtime/operator-token/miguel --query SecretString --output text) \
  node --experimental-strip-types deploy/smoke.ts
```

## Console and self-service

`https://agents.camelai.dev/console` is where people manage their own tenant:
- add or replace provider keys, which are checked with the provider and stored encrypted;
- browse models;
- mint and revoke API tokens;
- inspect and prompt agents;
- see usage.

Everything in the console is also available as the REST API under `/v1`, for
scripts that authenticate with an API token.

Sign-in uses GitHub and is limited to active members of the `qaml-ai` org. A
member's first sign-in creates a tenant named after their GitHub login. An
admin tenant is linked to a GitHub login with
`infra/tenant.sh link-github <tenant> <login>`. Token sign-in also works: paste
an operator token or an API token.

To enable GitHub sign-in, an org owner creates an OAuth app at
https://github.com/organizations/qaml-ai/settings/applications/new with:
- homepage `https://agents.camelai.dev`
- callback URL `https://agents.camelai.dev/console/auth/callback`

Then run `infra/github-oauth.sh <client-id>` and paste the client secret when
prompted. Tasks read this secret only at startup, so the script force-rolls the
service. Old tasks retire as in any deploy, so running turns finish.

## Tenants (admin)

Each person gets a tenant with its own operator token and provider keys. Their
agents are invisible to other tenants, and their model usage bills to their
own key. The script never prints secrets. Keys are read from stdin, and tokens
go to Secrets Manager.

```sh
infra/tenant.sh list
infra/tenant.sh add <tenant>
infra/tenant.sh set-key <tenant> anthropic      # key on stdin
infra/tenant.sh rotate-token <tenant>
infra/tenant.sh link-github <tenant> <login>
infra/tenant.sh set-limit <tenant> <n|default>  # hosted agents per task
infra/tenant.sh set-spend-limit <tenant> <usd|none>  # model spend per UTC month
infra/tenant.sh remove <tenant>
```

`set-limit` sets the tenant's `maxAgents` in the tenants secret: how many of its
agents one task hosts at once, in place of `AGENT_MAX_AGENTS_PER_TENANT` (500);
`default` removes it. A lower limit only gates new starts: agents already
running above it keep running. Past the limit, creating or waking an agent gets
429 with `Retry-After` (the SDKs retry it), and the task logs `quota_rejected`
with the limit and whether it was the tenant's own or the default.

`set-spend-limit` sets the tenant's `maxMonthlyCost` (USD) in the tenants secret;
`none` removes it, and without one a tenant's spend is unlimited (there is no
operator-wide default). Spend is the tenant's `GET /v1/usage` cost for the current
UTC month (list-price estimates, turns and compaction summaries alike), read from
the database at most every 5 seconds per task. At or over the cap, new model runs
(`prompt`, `continue`) get 402 with the reason, runs already queued complete with
that error, and a running turn ends after the model response that crossed the cap:
that response's tool calls finish and are recorded, then the turn stops with
`stopped: "spend_limit"` in its outcome. So a tenant can overshoot by about one
response per running agent. Code executions (`execute`) make no model calls and
are not limited. Raising the cap lets the agent carry on from where it stopped.

Changes take effect within a minute, when the tasks next re-read the tenants
secret. Nothing restarts, and running agents are unaffected. Share the operator
token through a password manager: it can create, read and drive every agent in
that tenant.

## Deploying changes

```sh
infra/ecs-deploy.sh          # build + push this checkout, register a revision, roll, wait
infra/ecs-deploy.sh <tag>    # deploy an image already in ECR
```

The script builds an arm64 image from the current checkout, tagged with the git
commit (plus `-dirty-<time>` for uncommitted runtime changes), and pushes it to
ECR. It registers a task definition revision with the new image, rolls the
service, and returns once the new tasks are healthy in the target group.

A deploy interrupts no turns:
- a busy task keeps itself protected from scale-in;
- a task replaced by a newer deployment retires itself: it finishes its
  running turns first (at most 6 h), then stops;
- on SIGTERM a task drains for up to 120 s;
- a turn interrupted by a crash is resumed by the agent's next owner.

Details, including how long a rollout stays `IN_PROGRESS`, are in
[`terraform/README.md`](terraform/README.md#deploying).

Runtime settings that aren't secret (default model, agent caps, idle and tool
timeouts) are `runtime_env` in `terraform/variables.tf`. Apply the change with
Terraform, then ship it with `infra/ecs-deploy.sh <running tag>`.

## SDKs

- TypeScript: `sdk`, published as `@camelai/agent-runtime`
  to GitHub Packages. Bump `version` in `sdk/package.json`, then run
  `npm publish` from that directory. Installation instructions are in
  `sdk/README.md`.
- Python: `clients/python` (`pip install <path or git URL>`).

## Operations

```sh
curl https://agents.camelai.dev/healthz
aws ecs describe-services --region us-west-2 --cluster camelai-agent-runtime \
  --services camelai-agent-runtime \
  --query 'services[0].deployments[].[status,rolloutState,runningCount,taskDefinition]'
aws ecs list-tasks --region us-west-2 --cluster camelai-agent-runtime
aws ecs execute-command --region us-west-2 --cluster camelai-agent-runtime --task <id> \
  --container agent-runtime --interactive --command sh
```

Logs are in the CloudWatch log group `/ecs/camelai-agent-runtime` (kept 30
days). The local AWS CLI is v1, which has no `aws logs tail`; use
`filter-log-events` (here, the last 15 minutes):

```sh
aws logs filter-log-events --region us-west-2 --log-group-name /ecs/camelai-agent-runtime \
  --start-time $(( ($(date +%s) - 900) * 1000 )) --query 'events[].message' --output text
```

## Limits

- Each task holds up to 1000 awake agents, at most 500 per tenant
  (`AGENT_MAX_AGENTS`, `AGENT_MAX_AGENTS_PER_TENANT`; the older names
  `AGENT_MAX_PROCESSES` and `AGENT_MAX_PROCESSES_PER_TENANT` still work). Idle agents stop
  after 5 minutes. When a tenant or the task is at its limit, the least recently
  used idle agent is stopped; if none is idle, the request is refused (429 for a
  tenant's limit, 503 for the task's). A tenant's own `maxAgents`
  (`infra/tenant.sh set-limit`) replaces the per-tenant default.
- Sandboxed code runs in the same task as agent state. Code runs in QuickJS
  compiled to WebAssembly, in a per-execution child process; a separate
  isolation tier (gVisor/Firecracker) is only warranted if agents ever run
  native code.
- Tool sources a tenant configures (MCP servers, OpenAPI APIs, `web_fetch`) are called from the task,
  only on public addresses: the runtime refuses private, link-local (including
  the metadata and ECS credential endpoints) and reserved ranges itself, and
  `AGENT_OUTBOUND_BLOCK_CIDRS` (the VPC's CIDR, set in `ecs.tf`) adds the VPC.
  The security group's egress stays open; the check is in the runtime, which
  resolves names and connects to the address it checked.
