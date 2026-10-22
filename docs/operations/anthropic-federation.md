# Anthropic via Workload Identity Federation

The platform can authenticate to Anthropic with its ECS task role instead of a long-lived API key.
Tenant keys and key scope entries still take precedence. This affects direct Anthropic model calls,
including background and foreground compaction. OpenRouter and Bedrock credentials stay separate.

## Set up the trust

An operator performs these account and production changes. The runtime does not enable federation itself.
The locked AWS provider (6.66.0) supports
[`aws_iam_outbound_web_identity_federation`](https://registry.terraform.io/providers/hashicorp/aws/6.66.0/docs/resources/iam_outbound_web_identity_federation). Account management
is a separate opt-in, `anthropic_federation_manage_account = true`, off by default. Its resource has
`prevent_destroy` because the issuer may serve other workloads. To manage an already-enabled account,
import `aws_iam_outbound_web_identity_federation.anthropic[0]` using the account ID before applying.
An operator can instead keep this setting unmanaged and perform the one-time CLI setup below.

1. Enable outbound identity federation once in the AWS account, with a current AWS CLI:

   ```sh
   aws iam enable-outbound-web-identity-federation
   aws iam get-outbound-web-identity-federation-info
   ```

   Already enabled is fine. Copy `IssuerIdentifier` from the second command. This is the account's STS
   issuer URL, not `https://sts.us-west-2.amazonaws.com`. See the
   [AWS setup guide](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_outbound_getting_started.html).

2. In the [Anthropic Console](https://platform.claude.com/settings/workload-identity-federation), choose
   **Connect workload**, then **AWS**. Configure:

   | Field | Value |
   | --- | --- |
   | Issuer | The account's STS issuer URL from the command above |
   | Rule match `subject_prefix` | The exact ECS task role ARN, with no wildcard |
   | Audience | `https://api.anthropic.com` |
   | Scope | `workspace:developer` |
   | Access token lifetime | 600 seconds |

   The role is `aws_iam_role.task`, named `${var.name}-task` in `infra/terraform/ecs.tf`.
   With the checked-in defaults, its name is **camelai-agent-runtime-task**, and its ARN is
   `arn:aws:iam::904534089871:role/camelai-agent-runtime-task`. Use the deployed task role ARN if
   `name` or `account_id` is overridden. Do not use the `-task-execution` role or a task session ARN.
   Record the federation rule, organization, service account and workspace IDs from Anthropic.

3. Set these four Terraform variables and have an operator review and apply the change:

   ```hcl
   anthropic_federation_rule_id = "<rule ID>"
   anthropic_organization_id    = "<organization ID>"
   anthropic_service_account_id = "<service account ID>"
   anthropic_workspace_id       = "<workspace ID>"
   ```

   They become `AGENT_ANTHROPIC_FEDERATION_RULE_ID`, `AGENT_ANTHROPIC_ORGANIZATION_ID`,
   `AGENT_ANTHROPIC_SERVICE_ACCOUNT_ID`, and `AGENT_ANTHROPIC_WORKSPACE_ID`. All empty means off.
   `AGENT_ANTHROPIC_FEDERATION_STS_REGION` optionally selects the STS region; otherwise it is
   `AWS_REGION`, then `us-west-2`. Terraform grants `sts:GetWebIdentityToken` on `*` to the task role.
   Roll the ECS service onto the updated task definition using the normal deployment procedure.

## Verify and remove the static key

Keep `platformKeys.anthropic` in the tenants secret during rollout. Federation takes precedence;
an exchange failure falls back to this key and logs `anthropic_federation_fallback`.

Run an Anthropic agent using the platform credential, without a tenant or scope key. Verify a successful
response and an `anthropic_federation_exchange` log with `ok: true`, `ms`, and `expires_in`. Wait through
refresh and verify another successful exchange. Check normal responses and compaction. The log also
publishes CloudWatch EMF exchange count, failure count, and duration metrics. Failures contain only a
fixed error class, never tokens, assertions, response bodies or upstream error messages.

After successful rollout and refresh, an operator can remove `platformKeys.anthropic` from the tenants
secret and reload it by the normal procedure. Leave the other platform and tenant keys in place.
Rollback: restore that key or clear all four IDs and deploy again. Without a static key, mandatory exchange
failure rejects the model call; it never sends an expired credential or uses another tenant's key.

## Token lifecycle and request authentication

Each exchange obtains a fresh STS JWT with audience `https://api.anthropic.com`, algorithm `RS256`, and
900-second lifetime. The runtime exchanges it at `POST https://api.anthropic.com/v1/oauth/token` with the
four IDs and grant type `urn:ietf:params:oauth:grant-type:jwt-bearer`. It never retries an exchange with the
same JWT: assertions containing `jti` are single-use. Requests to STS and Anthropic share a 10-second deadline.

The access token is cached per node. At expiry minus 120 seconds, the next call starts one background
refresh while serving the cache. Failed advisory refreshes retry no sooner than 10 seconds later. At
expiry minus 30 seconds, calls must await a fresh token or use the static fallback. Concurrent refreshes
share one exchange. No refresh runs on an idle node.

Messages requests carry `authorization: Bearer <access token>` and no `x-api-key`. Pi-ai 1.1.0 interprets
`sk-ant-oat` as a Claude subscription token. The runtime instead gives Pi a non-secret placeholder and
installs the bearer credential in its request adapter, preserving the system prompt and ordinary API
beta headers without adding Claude Code identity or subscription beta headers.

The models-list key check only validates tenant-supplied API keys; it never receives the platform token.
Voice, transcription and images use their existing OpenAI, Azure, Google or speech-provider credentials.
Tool search uses OpenRouter. None of those callers exchanges or sends an Anthropic token.
