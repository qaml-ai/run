# Tenants (admin)

A tenant is an account: its agents, definitions, volumes, tokens and usage are its own, invisible to other tenants.
There are two kinds.

- **Admin tenants** are entries in the **tenants file**. On the hosted runtime that is the Secrets Manager secret
  `camelai/agent-runtime/tenants` (`AGENT_TENANTS_FILE`; see [Configuration](configuration.md)). Operators make them for
  people and products: `miguel`, `chiridion-prod`, `camel-bots`. Each has an **operator token**, and its limits are
  fields of its entry. They are exempt from the self-serve usage tiers and per-address rate limits unless the entry
  sets a limit.
- **Self-serve tenants** are made by signing in to the console (GitHub, Google, email). They live in Postgres, are
  prepaid, and have their plan's limits ([Billing](billing.md)).

`infra/tenant.sh` edits the tenants file. Every node re-reads it within a minute: there's no restart, and running
agents are unaffected. The script never prints a secret: keys and passwords are read from stdin, and tokens go to
Secrets Manager.

## Commands

```sh
infra/tenant.sh list                              # each tenant: providers with keys, agent limit, spend limit
infra/tenant.sh add <tenant>                      # makes the tenant and its operator token
infra/tenant.sh remove <tenant>                   # drops it from the file (see below)
infra/tenant.sh rotate-token <tenant>             # a new operator token; the old one stops working
infra/tenant.sh set-key <tenant> <provider>       # the tenant's own provider key, from stdin (e.g. anthropic)
infra/tenant.sh set-limit <tenant> <n|default>    # busy agents across the fleet (maxAgents)
infra/tenant.sh set-spend-limit <tenant> <usd|none>  # model spend per UTC month (maxMonthlyCost)
infra/tenant.sh set-password <tenant> <email>     # console sign-in with email and password (stdin, or generated)
infra/tenant.sh set-password <tenant> --clear     # no more password sign-in
infra/tenant.sh link-github <tenant> <login>      # that GitHub account signs in to the console as the tenant
```

- **`add`**:
  - Tenant ids are lowercase letters, digits and dashes, up to 40.
  - The operator token goes to `camelai/agent-runtime/operator-token/<tenant>`; share it through a password manager.
  - The new tenant has no `billing`, so it is an unbilled admin tenant (see "Billing and keys").
- **`remove`**: the tenant's agents, volumes and data stay in storage, unreachable. Delete them through the API
  (with its token) first. Then delete the operator-token secret when nothing needs it.
- **`rotate-token`**: replaces the operator token at once. API tokens minted from the old one keep working; revoke
  them with `DELETE /v1/tokens/{id}`.
- **`set-key`**: the tenant's own key for a provider, used before the platform's. Its calls on that key aren't
  counted as platform usage.
- **`set-limit`**: how many of the tenant's agents may be busy at once, across the fleet. `default` removes it, which
  leaves `AGENT_MAX_AGENTS_PER_TENANT`. A lower limit only gates new starts: agents already running above it keep
  running. Past it, creating or waking an agent gets 429 with `Retry-After`, and the node logs `quota_rejected`.
- **`set-spend-limit`**:
  - It caps the tenant's model spend per UTC month: the cost `GET /v1/usage` reports (list-price estimates, turns and
    compaction alike), read from the database at most every 5 seconds per node. `none` removes it, and there is no
    operator-wide default.
  - At or over the cap, new model runs (`prompt`, `continue`, `POST /v1/runs`) get 402. Runs already queued end with
    that error, and a running turn stops after the model response that crossed the cap: that response's tool calls
    finish, then it ends with `stopped: "spend_limit"`. A tenant can overshoot by about one response per running
    agent.
  - Code executions (`execute`) make no model calls and aren't limited. Raising the cap lets agents carry on.
- **`set-password`**:
  - It calls `PUT /v1/tenants/{id}/password` with the operator token of `ADMIN_TENANT` (default `miguel`, which must
    be in `AGENT_BILLING_ADMINS`).
  - A generated password goes to a 0600 file (`~/.config/camelrun/password-<tenant>`, or `PASSWORD_FILE`).
  - Setting or clearing it ends the tenant's password sessions.
- **`link-github`**: the account is bound by its numeric id, looked up now, so a renamed account still signs in and
  whoever takes the freed login doesn't. The account's first sign-in uses this tenant.

## Credentials for a product

For a product running on an admin tenant (camel-bots, for one), give the product an **API token**, not the operator
token:

```sh
op=$(aws secretsmanager get-secret-value --region us-west-2 --secret-id camelai/agent-runtime/operator-token/<tenant> --query SecretString --output text)
curl -s -X POST -H "Authorization: Bearer $op" -H 'content-type: application/json' -d '{"name":"<product> prod"}' \
  https://run.camelai.com/v1/tokens | jq -r .token     # store it straight into the product's secret; it is shown once
```

An API token acts as the tenant for everything a product uses: agents, definitions, volumes, runs, browser tokens,
schedules and webhooks. It can be revoked on its own (`GET /v1/tokens`, `DELETE /v1/tokens/{id}`), and `/v1/me` says
`via: token`. Only operator routes need the operator token: billing adjustments, starting credit, and acting on other
tenants, which also need the tenant in `AGENT_BILLING_ADMINS`. To rotate, mint a new token, deploy it, then revoke
the old one.

## Other limits

An admin tenant's other limits are fields of its entry in the tenants file. They're listed under `AGENT_TENANTS_FILE`
in [Configuration](configuration.md), with their defaults in [Limits](../reference/limits.md):

- `maxWatchers`, `maxDiscordServers`, `maxVoiceSessions` and `maxStorageGb`;
- `maxAgentCreatesPerMinute` and `maxRunsPerMinute`;
- `maxRunResponses` and `maxRunSeconds`;
- `codeCpuMs`, `codeMaxTimeoutMs` and `codeConcurrency`;
- `decisionConcurrency`: decision calls at once on a node (default 16, or the tier's), at most
  `AGENT_DECISION_NODE_CONCURRENCY` (64). The tenant's queue (1,000) and in-flight characters (8 million) scale
  up with it in proportion, the characters at most the node's 32 million;
- `tier: "internal"`: the operator's own applications. No busy-agent, per-minute, js_exec or decision limit of
  the tenant's own, unless a field of its entry sets one. A node's caps (agents hosted, js_exec workers, decision
  calls, in-flight characters, memory, request bodies) and spend limits still apply.

A limit is the first of: the entry's field (or a self-serve tenant's `limits`), none on the internal tier, the
[usage tier](../reference/limits.md#usage-tiers)'s for a prepaid tenant, else the deployment's default. An unbilled
admin tenant keeps the defaults it had: no rate or js_exec limit, `AGENT_MAX_AGENTS_PER_TENANT` busy agents, 16
decision calls. `GET /v1/limits` shows a tenant every limit and where it comes from.

`tenant.sh` sets `maxAgents`, `maxMonthlyCost`, `decisionConcurrency` (`set-decision-concurrency`) and `tier`
(`set-tier`). For the others, edit the secret's JSON: get it, change the entry, and put it back with
`put-secret-value`, as the script does.

A **self-serve** tenant's limits are set through the API instead, by a billing-admin operator token:
`PUT /v1/tenants/{id}/limits`. It takes `{maxBusyAgents, maxStorageGb, agentCreatesPerMinute, runsPerMinute,
maxRunResponses, maxRunSeconds, codeCpuMs, codeMaxTimeoutMs, codeConcurrency, decisionConcurrency}`, and null returns
a limit to its tier's. For a tenant in the tenants file it answers 409: set those in the file.

## Managed computers

Not on yet: `AGENT_MANAGED_COMPUTERS` is off, and no tenant has one. A managed computer's machine runs on the platform's
Boat account (`platformKeys.boat`), and one tenant's abuse can get that account suspended, so use a Boat account for
these machines and nothing else.

- **Turning them off:** `AGENT_MANAGED_COMPUTERS=off` refuses new starts, and each pass stops every running one. For one
  account: `POST /v1/tenants/{id}/computers/stop`, with `{"block": true}` to refuse new starts until
  `DELETE /v1/tenants/{id}/computers/block`. Both need an `AGENT_BILLING_ADMINS` operator token. Bring-your-own
  connections are the account's own and aren't touched.
- **Changing the flag:** during a rolling deploy, tasks still on `off` stop machines started on tasks already `on`. For a
  first enable there is nothing running to stop. Later on, expect running computers to stop while it rolls out.
- **Whose machine:** each carries the labels `camelrun-runtime` (this runtime's public URL), `computer` and `tenant`, so
  an abuse report's machine leads to its account: `GET /sandboxes?label=tenant=<id>`. A runtime only sees machines with
  its own `camelrun-runtime`, so runtimes sharing an account leave each other alone. Give each its own
  `AGENT_PUBLIC_URL`: two with the same one would see each other's machines as leaks in their logs, though they delete
  nothing.
- **Logs:**
  - `computer_signature`: a command matched a miner, mining pool, mail-blast or scanner signature, by name, never the
    text. It's only logged; nothing is refused.
  - `computer_unavailable`: Boat refused a start (`code`).
  - `computer_started`: how long a start took (`ms`).
  - `computer_unit_fallback`: a command ran without its unit because `sudo` had gone, so a background process would
    outlive it.
  - `computer_kill_stop`, `computer_tenant_stopped`, `computer_credit_stop`: the stops.
  - `computer_agent_gone`: an agent revoked, purged or expired took its machine with it.
  - `computer_pass`, `computer_pass_failed`: each pass. If passes stop, machines still end at their TTL, uncharged.
- **What a pass costs:** each node lists every 30 seconds, one call per 200 machines: at 1,000 machines, 5 calls a pass,
  10 a minute per node, against Boat's 10,000 a minute per IP. Reads don't use Boat's start limits. A row a listing
  misses gets one more call to confirm before it ends.
  - `computer_leak`: a machine labelled for this runtime with no open row, over 10 minutes old. It isn't deleted: its
    TTL ends it, at most 24 hours after it started.
- **Egress:** not limited yet. Rules would go in `machineSetup` (`src/computers/abuse.ts`), which runs before an agent
  can use a machine. An agent has `sudo`, so rules set inside the machine don't bind it.

## Billing and keys

Which keys a tenant's model calls use, and who pays, is in [Billing](billing.md) (its opening table). In
short:

- **An admin tenant with no `billing` field (or `"billing": "none"`) is unbilled.** A call without a key of its own
  (or of its key scope) falls back to the platform's keys (the file's top-level `platformKeys`) and is recorded as
  platform usage (`platformResponses`, `platformCost` in `GET /v1/usage`). `"platformKeys": false` opts out: then
  the tenant uses only its own keys.
- **`"billing": "prepaid"`** makes an admin tenant pay for platform-key usage from credit, like a self-serve tenant.
- **Self-serve tenants are prepaid**, except those that signed up before billing existed, which stay unbilled and use only
  their own keys.

A product run by camelAI, such as camel-bots, is an unbilled admin tenant on the platform's keys, with a
`set-spend-limit` cap as its safety net.
