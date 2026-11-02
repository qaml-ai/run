# AWS

Let an agent read your AWS account without giving it a credential. You run a small MCP server
in your own account — one Lambda, one Function URL, one tool — and the runtime trusts it the way
it trusts any tool source of yours: with a token it signs for each call, naming the tenant, the
agent and whom the agent acts for. The Lambda makes the call with its own role.

The server, its Terraform and its tests are in
[`examples/aws-mcp-proxy`](https://github.com/qaml-ai/run/tree/main/examples/aws-mcp-proxy)
(MIT, no dependencies).

## How a call is trusted

The runtime signs an EdDSA token for every tool call: 120 seconds, one `jti` each, naming `tenant`,
`agent`, `sub` (whom the agent acts for) and `act` (who is acting). The function checks the
signature against the runtime's published keys, then the issuer, the audience, the expiry and the
tenant — and refuses anything else with a 401 that says which check failed.

`allowed_tenants` is the authorization boundary, not a formality: any tenant can make an agent and
point it at your URL, and the runtime signs their tokens too. Only the tenant check tells them
apart.

The audience is the URL the runtime called. If you put the function behind a custom domain, set
`audience` in the Terraform and the same value as `audience` on the definition, or use a name in
your tenant's namespace (`urn:camelrun:<tenant>:aws`).

Each call logs one line to CloudWatch Logs — `{tool, via, tenant, agent, subject, actor}` — so you
can see which agent, for whom, read what. No token material is logged.

## Deploy it

```sh
cd examples/aws-mcp-proxy
terraform init
terraform plan  -var 'allowed_tenants=["<your tenant id>"]'
terraform apply -var 'allowed_tenants=["<your tenant id>"]'
```

Your tenant id is `GET /v1/me` (or `agents.runtime.me()` in the SDK). It prints `url`. The role
reads EC2, ECS, CloudWatch, CloudWatch Logs, IAM and STS; narrow `main.tf` to what your agents
actually need.

## Point an agent at it

In a definition, so every agent made from it has the tool:

```json
{"name": "Ops", "mcpServers": [{
  "name": "aws", "url": "<the url it printed>", "auth": {"type": "runtime"},
  "allowTools": ["aws_read"], "exposure": "direct"
}]}
```

Or on an agent's own `mcpServers`, with no definition: `{"name": "aws", "url": "<url>", "auth":
{"type": "runtime"}}`. That is the only auth an agent's own servers take — credentials belong in a
definition, where they are sealed once.

Saving a definition calls `tools/list` on each server, so a wrong URL or audience is a **400 with
the reason** at save time, not a failed call later.

## What it will not do

- **Writes.** `aws_read` calls an operation only if its name reads (`Describe`, `List`, `Get`,
  `Search`, …). See [Writes](#writes).
- **Return credentials, secrets or object data.** `sts:GetSessionToken`,
  `secretsmanager:GetSecretValue`, `ssm:GetParameter`, `kms:Decrypt`, `s3:GetObject`,
  `ec2:GetPasswordData`, `lambda:GetFunction` and the rest of the list in `handler.mjs` are refused
  before anything is signed. A read-only policy is not enough on its own: those operations are
  reads.
- **Speak every service.** Six protocols are implemented: `ec2`, `sts`, `iam`, `cloudwatch`,
  `logs`, `ecs`. An unknown service is refused by name rather than guessed at.
- **Return more than fits.** A result is clipped at 18,000 characters, with a line saying how much
  was left.

The allowlist is the model-proof layer. IAM is the one that counts.

## Writes

Off, and the code that exists is a demonstration rather than a feature: set `ALLOW_WRITES=1` and
the server offers `aws_write`, which is still limited to three operations
(`cloudwatch:PutMetricAlarm`, `cloudwatch:DeleteAlarms`, and `ec2:RunInstances` with `DryRun=true`).

Two steps, and the second carries the first's answer:

1. Call without `confirm`: nothing runs, and the reply says exactly what would run and the digest —
   a SHA-256 of the service, operation and parameters.
2. Call again with that digest. A digest that does not match is refused: it means someone approved
   a different action.

An attempt is sent once. The runtime's `agent-runtime/idempotencyKey` names it, and a retry of the
same attempt answers "already sent" instead of running again. That cache lives in the process, so a
cold Lambda does not have it.

What it does not have, and what enabling writes in production needs first: the token's `approval`
claim pinned to a person's approval, target restrictions (by ARN or tag), reading the resource back
after the write to report observed state, and `AssumeRole` per call with `SourceIdentity` so
CloudTrail says which agent did it. Until then, a write is a role permission with a confirmation
prompt in front of it, not a governed change.

## When it refuses

| What you see | What it means |
|---|---|
| `401 Token is for … not this proxy` | The audience is not what the runtime called. Set `audience` in both places. |
| `401 Tenant … is not accepted by this proxy` | Another tenant's agent reached your URL. Add yours to `allowed_tenants` if it is yours. |
| `401 Token has expired` | A call took longer than two minutes between the runtime signing it and the function reading it — a cold start behind a slow network. |
| `400` when saving a definition | The server could not be listed: wrong URL, wrong audience, or nothing listening. The message says which. |
| `Error: … changes things` | The proxy refused a write. |
| `Error: This proxy never calls …` | The proxy refused an operation that returns credentials, secrets or object data. |
| `HTTP 403` from AWS | Your role's policy — not the proxy. |

## Limits and cost

One Lambda invocation per tool call, 256 MB and a 30-second timeout in `main.tf` (a Lambda allows 15
minutes at most; keep it under the tool's `timeoutMs`). A read is usually tens of milliseconds plus
however long AWS takes. Logs Insights is two calls the model drives: `StartQuery`, then
`GetQueryResults`.

There is no cap on tool calls per run or per source today: a run is bounded by its `maxRunSeconds`
and `maxRunResponses`. If you deploy this, watch the Lambda's invocations and your AWS throttles.

The function answers `GET /health` without a token, for a load balancer or a person checking.
