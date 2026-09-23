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
| `state-bucket.tf` | **New**: S3 bucket for agent state and the runtime role's access to it |
| `executor.tf` | **New**: executor tier, created only when `executor_count > 0` |

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

**Executor tier** (`executor_count`, default `0`). Setting it above zero creates:
- the `executor-token` secret container;
- the `camelai-agent-executor` and `-bootstrap` security groups, with the same
  rules as `infra/executor/provision.sh`;
- the runtime group's inbound 8791 rule from the executor group;
- the runtime role's read grant on the token;
- a launch template holding the hosts' non-secret launch settings.

The hosts themselves are still launched and replaced by `infra/executor/deploy.sh`,
because their user data carries the executor token, which must stay out of
Terraform state. That script can use the template with `--launch-template
LaunchTemplateName=camelai-agent-executor`. Terraform never sets secret values,
so after the first apply with executors enabled, set the token without printing
it:

```sh
openssl rand -hex 32 | tr -d '\n' > /tmp/executor-token && chmod 600 /tmp/executor-token
aws secretsmanager put-secret-value --region us-west-2 \
  --secret-id camelai/agent-runtime/executor-token --secret-string file:///tmp/executor-token >/dev/null
rm -f /tmp/executor-token
```

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

These are operational and stay:

- `infra/deploy.sh`: builds and pushes the image, installs `infra/instance/` over SSM.
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
