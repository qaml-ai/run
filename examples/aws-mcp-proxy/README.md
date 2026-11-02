# An AWS MCP server for your own account

One Lambda, one Function URL, one tool: `aws_read`. camelRun's agents ask it to read EC2, ECS,
CloudWatch, CloudWatch Logs, IAM and STS, and it answers with your account's own role. No AWS
credential ever reaches the agent, and no shared secret exists.

## How the caller is trusted

The runtime signs an EdDSA token for **every tool call**, naming the tenant, the agent, whom the agent
acts for, and who is acting (120 seconds, one `jti` each). This function checks the signature against
the runtime's published keys, then the issuer, the audience, the expiry, and the tenant. Then it makes
the call with its own IAM role.

`allowed_tenants` is the authorization boundary, not a formality: any tenant can make an agent and
point it at your URL, and the runtime signs their tokens too. Only the tenant check tells them apart.

Every call logs one line to CloudWatch Logs — `{tool, via, tenant, agent, subject, actor}` — so you can
see which agent, for whom, read what.

## What it will not do

- **Writes.** `aws_read` only calls an operation whose name reads (`Describe`, `List`, `Get`,
  `Search`, …). `aws_write` exists in the code, behind `ALLOW_WRITES=1` and a preview/confirm digest,
  and is off: turning it on is its own project (approval, target allowlists, verification). If you do,
  the digest is what a person approves — the model cannot invent it.
- **Return credentials, secrets or object data.** `sts:GetSessionToken`, `secretsmanager:GetSecretValue`,
  `ssm:GetParameter`, `kms:Decrypt`, `s3:GetObject`, `ec2:GetPasswordData`, `lambda:GetFunction` and
  the rest of the list in `handler.mjs` are refused before anything is signed.
- **Speak every service.** Six protocols are implemented (`ec2`, `sts`, `iam`, `cloudwatch`, `logs`,
  `ecs`). An unknown service is refused by name rather than guessed at.

The allowlist is the model-proof layer. IAM is the one that counts: `main.tf` grants reads on those six
services — narrow it further to what you actually need.

## Deploy

```sh
terraform init
terraform plan -var 'allowed_tenants=["your-tenant-id"]'   # tenant id: GET /v1/me
terraform apply -var 'allowed_tenants=["your-tenant-id"]'
```

It prints `url`. Then point a definition at it — no secret to hold:

```json
{"name": "Ops", "mcpServers": [{
  "name": "aws", "url": "<the url it printed>", "auth": {"type": "runtime"},
  "allowTools": ["aws_read"], "exposure": "direct"
}]}
```

An agent's **own** `mcpServers` take `auth: {"type": "runtime"}` too, so you do not need a definition
either: `{"name":"aws","url":"…","auth":{"type":"runtime"}}` on `POST /v1/agents`.

Saving a definition calls `tools/list`, so a wrong URL or audience is a 400 with the reason at save
time, not a mystery later.

Behind a custom domain, set `audience` to what the runtime will sign — its own URL as called, or a
name in your tenant's namespace (`urn:camelrun:<tenant>:aws`) if you also set the same `audience` on
the definition.

## Test it

```sh
node --test test.mjs
```

No AWS account needed: **botocore**, AWS's own signer, checks the proxy's signatures, and a stub
stands in for the service. The tests cover the four ways a caller can be refused (wrong audience,
wrong tenant, expired, forged signature), the read/never-call lists, and the write digest gate.

Two traps worth knowing if you change `handler.mjs`, both of which produce a well-formed signature
AWS rejects as `InvalidSignatureException`:

- **CloudWatch is `monitoring` twice over**: its host is `monitoring.<region>.amazonaws.com` and its
  SigV4 signing name is `monitoring`. Only its IAM actions are `cloudwatch:`.
- **Query APIs take lists as `Key.member.1=a`**, not a JSON array (that one is `MalformedInput`).

Also: SigV4 must sign `host` explicitly, and the signer's "sha256" is an HMAC when it is constructed
with a secret — a class that ignores the secret signs deterministically and wrongly.

## Cost and limits

A Lambda invocation per tool call, at 256 MB / 30 s; a read is typically tens of milliseconds plus how
long AWS takes. `GetQueryResults` for Logs Insights is asynchronous — the model drives the two steps
(`StartQuery`, then `GetQueryResults`). Long jobs must stay inside the function's timeout (30 s here,
15 minutes at most for a Lambda).

## A shared secret, if you need one

Clients that are not camelRun (Claude Desktop, `curl`) cannot mint a runtime token. Set
`SECRET_SHA256` to the SHA-256 of a secret you generate and they can send it as
`Authorization: Bearer <secret>` — but note what it costs: a secret names nobody, so calls appear as
`agent: mcp-secret`, and it is valid until you rotate it. Prefer the token.
