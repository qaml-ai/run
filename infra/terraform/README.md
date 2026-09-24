# Terraform for the hosted agent runtime

This directory describes the runtime's AWS and Cloudflare infrastructure (AWS
account `904534089871`, `us-west-2`, plus the us-east-1 alerting). It replaces
the provisioning shell scripts; the operational scripts stay.

| File | Contents |
|---|---|
| `runtime.tf` | EC2 host, Elastic IP, security group and rules, IAM role/profile/policy, ECR repository, DLM snapshots, recover/reboot alarms (all existing) |
| `secrets.tf` | Secrets Manager containers under `camelai/agent-runtime/` (existing) |
| `monitoring.tf` | Route 53 health check, `-healthz` alarm and SNS topic in us-east-1 (existing) |
| `dns.tf` | Cloudflare A record `agents.camelai.dev` (existing) |
| `imports.tf` | `import {}` blocks that adopt everything above |
| `state-bucket.tf` | S3 bucket for agent state and the runtime role's access to it |
| `alb.tf` | **New**: public ALB, ACM certificate (validated through Cloudflare), target group, listeners, ALB security group |
| `ecs.tf` | **New**: ECS cluster, Fargate service, task definition, task and execution roles, task security group, autoscaling, the RDS rule for tasks |
| `alarms.tf` | **New**: ALB/ECS alarms and their us-west-2 SNS topic |
| `executor.tf` | **New**: executor tier (private subnets, VPC endpoints, internal NLB, Auto Scaling group), created only when `executor_enabled` |

`dns.tf` now takes `dns_target` (`host` or `alb`) to choose where the record points.

## Prerequisites

- OpenTofu >= 1.10 (`brew install opentofu`; the provider lock file is committed; run `tofu init`). Terraform >= 1.10 also works.
- AWS credentials for account `904534089871`. The providers refuse any other account.
- `CLOUDFLARE_API_TOKEN` in the environment with DNS edit access to `camelai.dev`.
  Without it, planning the DNS record fails.

## Plan and apply

```sh
cd infra/terraform
tofu init
tofu plan -out=tfplan
tofu apply tfplan
```

Always apply a saved plan you have read. The instance, Elastic IP, state bucket
and the session-secret/secrets-key/tenants/github-oauth secrets have
`prevent_destroy`; Terraform refuses any plan that would delete them.

## The import step

`imports.tf` maps each existing resource to its address in this configuration
(IDs were found with read-only describe/list calls). `tofu plan` reads the
live resources and compares them to the configuration. The first plan shows:

- `26 to import`: the existing resources, with no changes to them;
- `5 to change`: the five imported secrets. The only difference is
  `recovery_window_in_days = 30` and `force_overwrite_replica_secret = false`.
  These are Terraform-only settings that an import cannot read, so the apply
  writes them to state and makes no AWS API call;
- `7 to add`: the new state bucket and its IAM policy (`state-bucket.tf`).

`tofu apply` records the imported resources in state. After that the
import blocks do nothing, and you can delete them. If you want to adopt the
existing infrastructure without creating the bucket yet, apply with
`-target` on the imported addresses, or move `state-bucket.tf` aside for that apply.

Nothing about the host is replaced. `ami` and `user_data` are ignored because
the AMI was current at launch and user data only ran at first boot. `deploy.sh`
configures the host over SSM.

## New resources

**State bucket** (`camelai-agent-runtime-state`): versioned, all public access
blocked, SSE-S3, ACLs disabled. Noncurrent versions expire after 30 days
(`noncurrent_version_days`), expired delete markers are removed, and incomplete
multipart uploads are aborted after 7 days. The runtime role gets
`s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `<bucket>/agents/*`,
and `s3:ListBucket` limited to the `agents/` prefix. Conditional writes
(`PutObject` with `If-None-Match: *` or `If-Match: <etag>`, used by
`shared/s3-storage.ts`) need only `s3:PutObject`, so nothing more is granted.
To point the runtime at it, set `AGENT_STORAGE=s3`, `AGENT_S3_BUCKET` and
`AGENT_S3_PREFIX` from the `state_bucket` output.

**Executor tier**: see "Executor tier" below.

## Architecture (ECS)

```text
          agents.camelai.dev  (Cloudflare, DNS only; dns_target = alb)
                   │ CNAME
                   ▼
   ALB camelai-agent-runtime   (default public subnets, 4 AZs)
     :443  ACM cert, TLS 1.2/1.3, idle timeout 360 s
     :80   301 to https
                   │ target group (ip) :8790, GET /healthz, deregistration 110 s
                   ▼
   ECS Fargate service camelai-agent-runtime  (ARM64, 1 vCPU / 2 GB, 2..10 tasks)
     tasks in the default subnets with public IPs (egress to model providers, no NAT)
     SG task: 8790 from the ALB and from itself (node-to-node forwarding)
              8791 from executors (when enabled)
     ├── RDS Postgres (5432 from the task SG)
     ├── S3 camelai-agent-runtime-state/agents/*  (task role)
     └── internal NLB :8790 ──▶ executor ASG (private subnets, no internet)   [executor_enabled]
                                     └── callbacks to task-ip:8791
```

- **Task definition** (`ecs.tf`). Settings come from `var.runtime_env`, which
  holds the non-host settings of `instance/runtime.defaults.env`. Storage, database,
  public-URL and tenant settings are derived from the resources:
  - `AGENT_STORAGE=s3`, `AGENT_S3_BUCKET`, `AGENT_S3_PREFIX`, `AWS_REGION`;
  - `AGENT_DATABASE_HOST`, `AGENT_DATABASE_SECRET_ARN`, `AGENT_DATABASE_CA`;
  - `AGENT_PUBLIC_URL`, `AGENT_TENANTS_SECRET_ARN`.

  ECS injects `AGENT_SESSION_SECRET`, `AGENT_SECRETS_KEY`, and
  `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`. The last two are JSON keys of
  `github-oauth`. With executors enabled it also injects `AGENT_EXECUTOR_TOKEN`.
  The runtime reads the RDS and tenants secrets itself, through the task role.
  Logs go to `/ecs/camelai-agent-runtime`, kept for 30 days.
- **Roles**. The execution role has `AmazonECSTaskExecutionRolePolicy` and read
  access to the `secrets` above. The task role has the same S3 statements as the
  host role (`local.state_bucket_statements`), read access to the RDS and
  tenants secrets, `ecs:UpdateTaskProtection`/`ecs:GetTaskProtection` on this
  cluster's tasks, `ecs:DescribeServices` on this service, and ECS Exec. To get a shell:
  `aws ecs execute-command --cluster camelai-agent-runtime --task <id> --container agent-runtime --interactive --command sh`.
- **Scaling**. Target tracking holds average CPU at 60% and average memory at 70%,
  within `service_min_count`..`service_max_count` (2..10). Scale-in has a
  5-minute cooldown. `ecs.tf` has a commented example of scaling on an
  `AgentRuntime` EMF metric instead.
- **Task protection**. The runtime turns on ECS scale-in protection for its own
  task while turns are running (`AGENT_ECS_CLUSTER`, `AGENT_ECS_SERVICE` are
  set for it). Scale-in skips protected tasks, so it removes idle tasks first;
  when every task is busy, the desired count drops but the extra tasks keep
  running until their turns finish.
- **Stopping a task** (deploy, scale-in, rebalancing):
  0. If the task is protected, ECS waits until the runtime clears protection
     (its turns have finished, or `AGENT_RETIRE_MAX_MS`, default 6 h, passed).
  1. ECS deregisters the task, and the ALB keeps its open connections for 110 s.
  2. ECS sends SIGTERM. `/healthz` returns 503 while the runtime drains agents
     (about 100 s).
  3. SIGKILL follows 120 s after SIGTERM (`stopTimeout`).
- **Deployments** are rolling: `minimumHealthyPercent` 100 and `maximumPercent`
  200. The circuit breaker rolls back automatically if new tasks never pass
  `/healthz`. It counts failed task launches, not time, so old tasks that stay
  protected for hours never trip it. A deployment's `rolloutState` stays
  `IN_PROGRESS` until its last old task is gone: up to `AGENT_RETIRE_MAX_MS`
  (6 h) + 110 s + 120 s. The runtime notices a newer deployment and retires
  itself once idle. Don't make CI wait on `services-stable` or on
  `rolloutState = COMPLETED`; wait as `ecs-deploy.sh` does.
- **Alarms** (`alarms.tf`, us-west-2):
  - `-unhealthy-hosts`: `UnHealthyHostCount > 0` for 3 minutes;
  - `-alb-5xx`: more than 10 ALB-generated 5xx in 5 minutes;
  - `-target-5xx`: more than 25 task 5xx in 5 minutes;
  - `-running-tasks`: `RunningTaskCount` below the minimum for 5 minutes. This
    needs Container Insights.

  CloudWatch alarms can only notify a topic in their own region, so these use
  the new us-west-2 topic `camelai-agent-runtime-alerts` (output
  `alerts_topic_arn_regional`). Subscribe to it as well as to the us-east-1
  topic.

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
6. Checks `/healthz` through the ALB.

It does **not** wait for the old tasks to stop. They retire in the background,
each once its running turns end (at most `AGENT_RETIRE_MAX_MS`, default 6 h),
then drain as above. The script prints the command to follow them. A deploy
interrupts no turns. Two deploys in a row are fine: a task superseded twice
retires the same way.

When Terraform changes environment, secrets or cpu/memory, it registers a new
revision with the image from `runtime_image_tag`, but the service keeps running
the old one. To ship the change, deploy the running tag:
`infra/ecs-deploy.sh <tag>`. The deploy copies Terraform's newer revision and
sets the image. To see which tag is running:

```sh
aws ecs describe-task-definition --region us-west-2 --task-definition camelai-agent-runtime \
  --query 'taskDefinition.containerDefinitions[0].image' --output text
```

Leave `runtime_image_tag` at a tag that exists. Terraform only uses it when it
registers a revision.

## Cutover from the EC2 host

The old host and the ECS tasks must never both serve real traffic. The old host
advertises `127.0.0.1` as its node URL and cannot reach the tasks on 8790, so
requests forwarded between them fail. Coexisting is safe, but agents owned by
the other side are unavailable. So the old runtime keeps all real traffic until
step 3, stops at step 3, and from then on ECS serves everything.

0. **Create alongside.** Run `tofu plan` with default vars
   (`dns_target = "host"`). It adds only new resources, plus one new rule on the
   RDS security group. Review it, then apply. ACM validation takes a few minutes,
   and the service starts `service_min_count` tasks. The image
   (`runtime_image_tag`) must include the ECS runtime changes (tenants from
   `AGENT_TENANTS_SECRET_ARN`, node URL from ECS metadata, drain on SIGTERM).
1. **Verify ECS through the ALB** while the old runtime still serves. Use test
   agents only. An agent the old host owns is unavailable through the ALB, and
   the reverse is also true.
   ```sh
   alb=$(tofu output -raw alb_dns_name)
   curl -fsS --connect-to agents.camelai.dev:443:$alb:443 https://agents.camelai.dev/healthz
   ```
   To use the console and run a test agent's turns, add `<ALB IP>
   agents.camelai.dev` to `/etc/hosts` (`dig +short $alb` gives the IPs). Check
   the task logs in `/ecs/camelai-agent-runtime`, and check that
   `aws ecs describe-services` shows `service_min_count` running tasks, healthy
   in the target group.
2. **Lower the TTL.** Apply with `dns_ttl = 60`, then wait at least the old TTL
   (300 s).
3. **Proxy the old host to the ALB, then stop its runtime.** Install
   `infra/instance/Caddyfile.alb-proxy.template` as the host's Caddyfile, and
   restart Caddy (its admin API is off, so it can't reload). Then stop the
   runtime container. Its shutdown deletes its heartbeat, so the ECS tasks take
   over its agents. From here, clients that still resolve the Elastic IP are
   proxied through the ALB, and nothing is refused while DNS propagates.
   ```sh
   cd infra
   source config.sh
   alb=$(tofu -chdir=terraform output -raw alb_dns_name)
   caddyfile=$(sed "s/RUNTIME_HOSTNAME/$HOSTNAME/g; s/ALB_DNS_NAME/$alb/g" instance/Caddyfile.alb-proxy.template | base64 | tr -d '\n')
   remote="set -euo pipefail
   echo '$caddyfile' | base64 -d > /opt/agent-runtime/Caddyfile
   systemctl restart agent-runtime-caddy.service
   systemctl disable --now agent-runtime.service
   docker ps --format '{{.Names}} {{.Status}}'"
   params=$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]]}))' "$remote")
   id=$(aws ssm send-command --region $REGION --instance-ids i-0f27dc58911079f90 \
     --document-name AWS-RunShellScript --comment "cutover: proxy to ALB" \
     --parameters "$params" --query Command.CommandId --output text)
   aws ssm wait command-executed --region $REGION --command-id $id --instance-id i-0f27dc58911079f90
   aws ssm get-command-invocation --region $REGION --command-id $id --instance-id i-0f27dc58911079f90 \
     --query '[Status,StandardOutputContent,StandardErrorContent]' --output text
   curl -fsS https://agents.camelai.dev/healthz   # still via the Elastic IP, now served by ECS
   ```
   - `systemctl disable --now` stops the container gracefully, with
     `docker stop --time 30`, and keeps it stopped across reboots.
   - Only `agent-runtime-caddy` keeps running, and it keeps its Let's Encrypt
     certificate.
   - **Rollback:** restore the normal Caddyfile and restart, with
     `infra/deploy.sh`. It reinstalls `Caddyfile.template` and restarts both
     services.
4. **Flip DNS.** Apply with `dns_target = "alb"` (and `dns_ttl = 60`). The plan
   shows `cloudflare_dns_record.runtime must be replaced`. The Cloudflare provider
   cannot change a record's type in place, so the apply deletes the A record and
   creates the CNAME, with less than a second between the two. A resolver that
   asks in exactly that instant caches NXDOMAIN for the zone's negative TTL (SOA
   minimum, 1800 s). To shrink that risk, apply at low traffic. If your
   Cloudflare plan allows a custom SOA, you can also lower the zone's SOA minimum
   TTL to 60 for the window. Clients that still have the A record keep going
   through the proxy.
   **Rollback:** apply `dns_target = "host"`. It still points at the proxy,
   which is harmless.
5. **Watch, then retire the host.** Watch for the TTL window, then a day:
   - `dig +short agents.camelai.dev` returns the ALB;
   - the Route 53 health check stays green;
   - the new alarms stay OK;
   - the old host's proxied traffic falls to zero (use the CloudWatch
     `NetworkIn` of `i-0f27dc58911079f90`).

   Then remove the host, in a separate change to this config:
   - remove `disable_api_termination` and `prevent_destroy` from
     `aws_instance.runtime` and `aws_eip.runtime`, and apply that;
   - delete `aws_instance.runtime`, `aws_eip.runtime`,
     `aws_eip_association.runtime`, `aws_dlm_lifecycle_policy.runtime` (and the
     `dlm_default` data source), the `system_check` and `instance_check` alarms,
     and their import blocks;
   - delete `dns_target` and make `dns.tf` a plain CNAME to the ALB. A config
     that no longer references the EIP must not still say `host`.

   Also, when the host goes:
   - Its root volume has `delete_on_termination = false`. Delete it with the
     instance: it held Caddy's certificates and the old `/data` agent working
     directories, which are ephemeral now.
   - Delete the DLM snapshots (tag `Backup = camelai-agent-runtime`) with
     `aws ec2 delete-snapshot` once you no longer want them. DLM does not delete
     snapshots for a deleted policy.
   - The host role, instance profile and runtime security group can go in the
     same change. Remove `database_from_runtime` first, since the RDS rule
     references the security group.
   - Caddy, `infra/deploy.sh` and `infra/instance/` go with the host.

**Route 53 health check.** `aws_route53_health_check.healthz` already targets
the hostname (`fqdn = agents.camelai.dev`), not the IP, so after the flip it
checks through the ALB and needs no change. Its us-east-1 alarm and topic stay.
The recover/reboot alarms are EC2-only and go with the host.

## Executor tier

`executor_enabled` stays `false` by default. **Enabling it needs sign-off from
the owners of the other workloads in the default VPC** (the django-app ECS
services, staging and production). See "VPC-wide effect" below: turning it on
changes how those services reach ECR, Secrets Manager and CloudWatch Logs.

Set `executor_enabled = true` and `executor_ami_id` (the Packer AMI from
`infra/executor`, with Docker and gVisor preinstalled: the subnets have no
internet). That creates:

- **Private subnets**, one per AZ: `172.31.80.0/24`, `.81`, `.82` and `.83`
  (`executor_private_subnets`). They share a route table with only the local
  route and the S3 gateway endpoint.
- **VPC endpoints** with private DNS: `ecr.api`, `ecr.dkr`, `secretsmanager` and
  `logs` as interface endpoints, and `s3` as a gateway endpoint.
  - The interface endpoints sit in `executor_endpoint_az_count` (2) AZs, since
    each AZ costs extra.
  - `ssm`, `ssmmessages` and `ec2messages` endpoints with private DNS **already
    exist** in the default VPC (django-app-ecs-staging, SG `sg-0fc3387d0ca916343`,
    443 from 172.31.0.0/16). A second endpoint with private DNS cannot be created,
    so executors use those (`shared_ssm_endpoint_security_group_ids`). If that
    stack ever removes them, add the three services to
    `local.executor_interface_endpoints`.
  - **VPC-wide effect:** private DNS applies to the whole default VPC. Once
    these endpoints exist, every workload there resolves ECR, Secrets Manager
    and CloudWatch Logs to them, including other stacks' ECS services and this
    runtime. That's why the endpoint SG admits 443 from the VPC CIDR. Tightening
    it would break those workloads.
    - Their image pulls, secret reads and log shipping then go through
      endpoints this stack owns.
    - Destroying the tier, or an endpoint outage, affects them too. Private DNS
      reverts to the public endpoints when the endpoints are deleted.
    - Their traffic to these services is billed at $0.01/GB through the
      endpoints.
  - **Alternative (not built):** a dedicated VPC for the runtime and executors.
    - It would hold its own public subnets (ALB, tasks), private executor
      subnets and endpoints, so private DNS affects only this stack, and the
      `ssm*` endpoints are its own rather than borrowed from django-app staging.
    - The control-plane RDS either moves into it (a snapshot restore or blue/green
      into a new subnet group, with a short write outage), or stays in the
      default VPC and is reached over VPC peering or a Transit Gateway. Peering
      needs non-overlapping CIDRs (for example 10.60.0.0/16), routes on both
      sides, and the RDS SG admitting the new task CIDRs; SG references don't
      cross peering in the same way.
    - The cost is the same endpoints and NLB plus a re-cut of the ALB and
      service networking. It's the cleaner design if the executor tier is
      going to production.
- **Internal NLB** `camelai-agent-executor` on :8790, with client IPs
  preserved. It health-checks `/healthz`, and the runtime's `AGENT_EXECUTOR_URL`
  points at it (with `AGENT_EXECUTOR_TOKEN` from `secrets`).
  `AGENT_EXECUTOR_CALLBACK_URL` stays unset, because each runtime task derives
  its own IP on ECS. Routing is
  now health-aware, which closes the old "random executor" gap.
- **Auto Scaling group**: `executor_min_size`..`executor_max_size` (2..6),
  target-tracking CPU at 60%.
  - A new launch template version (AMI, image, settings) triggers a rolling
    instance refresh.
  - The launch template: `t4g.small`, no public IP, IMDSv2 with hop limit 1,
    an encrypted 16 GB gp3 root volume.
  - The instance role has SSM core, reads the executor-token secret, pulls from
    ECR, and writes to `/camelai/agent-executor`.
  - User data is `templatefile("../executor/user-data.sh", {region, image,
    token_secret_arn, log_group, runtime_callback_cidr, max_concurrency})`. It
    holds no secret: hosts read the token at boot.
- **Security groups**:
  - tasks → NLB :8790 → executors :8790 (the executor SG admits the task SG and
    the NLB SG);
  - the host firewall in `user-data.sh` admits 8790 only from
    `runtime_callback_cidr` and lets the executor call back only into it.
    That variable is `172.31.0.0/17`, which holds the task subnets
    (172.31.0.0/18) and the executor subnets (172.31.80.0/22, where NLB health
    checks come from). A precondition checks that. The security groups do the
    precise restriction;
  - executors → task SG :8791 (callbacks), → endpoints :443, and → S3 prefix
    list :443. Nothing else.

After the first apply with executors enabled, set the token without printing it:

```sh
openssl rand -hex 32 | tr -d '\n' > /tmp/executor-token && chmod 600 /tmp/executor-token
aws secretsmanager put-secret-value --region us-west-2 \
  --secret-id camelai/agent-runtime/executor-token --secret-string file:///tmp/executor-token >/dev/null
rm -f /tmp/executor-token
```

Then deploy the runtime (`infra/ecs-deploy.sh <running tag>`), so the tasks get
the token and the executor URL. Tasks fail to start while the secret has no
value, so set it before that deploy.

## Monthly cost (us-west-2, on-demand, before tax)

| Item | Estimate |
|---|---|
| Fargate ARM64, 2 tasks × 1 vCPU / 2 GB (730 h) | ~$58 (each extra task ~$29) |
| Public IPv4: 2 tasks + 4 ALB addresses ($3.65 each) | ~$22 |
| ALB hour + LCUs (light traffic) | ~$22 |
| CloudWatch Logs, Container Insights, 4 alarms | ~$10 |
| **ECS runtime total at minimum** | **~$112** |
| Removed with the host: t4g.medium, 40 GB gp3, EIP, snapshots | about −$33 |
| Executor tier (when enabled): 2 × t4g.small + EBS | ~$27 |
| 4 interface endpoints × 2 AZs ($0.01/h each) | ~$58 |
| Internal NLB | ~$21 |
| **Executor tier total at minimum** | **~$106** |

## Secrets

Terraform manages the secret **containers** only: names, descriptions, deletion
behaviour. It never reads or writes values. There is deliberately no
`aws_secretsmanager_secret_version` anywhere, so state holds no secret material.
`infra/tenant.sh add` creates `operator-token/<tenant>` secrets. To bring a new
one under Terraform, add the tenant to `operator_token_tenants` and add an
import block for its ARN.

## Scripts: replaced vs kept

Once this configuration has been applied, these are superseded. They stay in the
repo for now, but don't run them against resources Terraform manages:

- `infra/provision.sh`: every resource it creates is in `runtime.tf`,
  `secrets.tf`, `monitoring.tf` and `dns.tf`. The exceptions are the initial
  random values of `session-secret` and `secrets-key`, and the DLM default role
  (`aws dlm create-default-role`), which Terraform only references.
- `infra/executor/provision.sh`: `executor.tf`.
- After the cutover, `infra/deploy.sh`, `infra/instance/*` and
  `infra/executor/deploy.sh` (host-based executors) are superseded by
  `infra/ecs-deploy.sh` and the executor Auto Scaling group.

These are operational and stay:

- `infra/ecs-deploy.sh`: builds and pushes the image and rolls the ECS service (see "Deploying").
- `infra/deploy.sh`: builds and pushes the image, installs `infra/instance/` over SSM (EC2 host, until it is removed).
- `infra/executor/deploy.sh`: launches and replaces executor hosts.
- `infra/tenant.sh`: tenant and operator-token secret values.
- `infra/github-oauth.sh`: the GitHub OAuth secret value.
- `infra/config.sh` and `infra/instance/*`: used by the scripts above.

## Remote state

State lives in `s3://camelai-terraform-state-904534089871/agent-runtime/terraform.tfstate`
(us-west-2; versioned, encrypted, public access blocked). The bucket was created
once by hand, outside this configuration. OpenTofu locks the state with a lock
object next to it (`use_lockfile`), so no DynamoDB table is needed. State holds
resource IDs and ARNs but no secret values.

## Known gaps

- The SNS topic `camelai-agent-runtime-alerts` has **no subscriptions**, so
  healthz alarms go nowhere. Subscribe with the command in the
  `alerts_topic_arn` output description.
- The hourly snapshot schedule runs at `00:39` past the hour. AWS chose that
  time when the policy was created without one; the config pins it.
