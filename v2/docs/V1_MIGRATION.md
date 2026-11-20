# Moving Camel Bots to v2

## Copy a v1 volume

The importer reads a v1 volume and its snapshots, then writes one commit per
version to a dedicated v2 repository. Create the repository first and keep the
repository ID and initial commit for retries. Set the four connection variables
in the execution environment. Each key belongs to the corresponding tenant.

```sh
node --experimental-strip-types v2/scripts/migrate-volume.ts \
  <v1-volume-id> <v2-repo-id> <v2-initial-commit>
```

The variables are `V1_URL`, `V1_API_KEY`, `V2_URL`, and `V2_API_KEY`.
The JSON output gives the source volume and draft sequence, destination repo
and head, and a map from v1 snapshot IDs to v2 commits. The importer verifies
paths and blob hashes and records its progress in each commit. Run it again
with the same repository and initial commit to resume or catch up. It rejects
foreign commits and returns an error if v1 changes during the copy.

The import stores one version in one transaction. A version whose changed
files exceed camelfsd's request size limit needs a larger-object import path.
V1 snapshot names, labels, and retention settings stay in v1. Camel Bots uses
its own saved and released version records to resolve the snapshot IDs in the
output.

## Stage an existing agent

Configure a private v2 agent with the desired model and tools. If the v1
agent has a workspace mount, attach an empty v2 repository on its default
branch and keep the initial commit. Use the same environment as the volume
importer.

```sh
node --experimental-strip-types v2/scripts/stage-agent.ts \
  <v1-agent-id> <v2-agent-id> --initial-commit <v2-initial-commit>
```

The command verifies that no v1 turn or approval is in progress, copies the
workspace and history, reads the copies back, and checks the source again.
It returns the history receipt, workspace sequence and snapshot commit map.
For an agent without a workspace, omit `--initial-commit`. To catch up a
staged copy, pass the last `--previous` history receipt. Use
`--attachments manifest.json` for history that references files.

For a Camel Bots builder with a private `/workspace` and a shared `/bot`
draft, add `--camel-bots-draft <v1-volume-id>` and provide the application's
read-only Postgres connection in `CAMEL_BOTS_DATABASE_URL`. The command
checks the builder's access to that exact open draft before and after copying
the workspace. The receipt includes the bot, builder owner, and draft volume.
Camel Bots keeps using the same shared draft through its app-owned tools, so
collaborator edits and saved releases stay on the existing volume. An old
history attachment from `/bot` needs its exact bytes copied to the private
workspace and pinned by the attachment manifest.

The app still needs to hold admission while it runs the final catch-up and
changes the route. A staging receipt describes a verified copy at a point
in time.

After holding application edits and ingress, use the v1 control database to
fence an idle source before the final catch-up. Migration `143_agent_v2_cutover.sql`
adds the fence to the admission write already used by deployed v1 nodes.

```sh
node --experimental-strip-types scripts/ops/agent-v2-cutover.ts \
  fence <v1-tenant> <v1-agent-id> <operation-uuid>
```

Retry with the same operation ID after an uncertain result. The command
refuses agents with open or recoverable work, input records, running children,
schedules, channel bindings, triggers, or open voice calls. Keep the fence
after the application publishes the v2 route. If the cutover is abandoned
before publication, run `unfence` with the same arguments.

## Keep the existing v1 client

The compatibility route preserves the v1 tenant key, agent token, agent ID, and
request IDs. It covers plain text prompts, request receipts, agent state,
watch streams, event polling, and transcript reads. V2 runs use the destination
tenant's credits. File uploads, attached tools, voice, and the other v1 API
families still require the v1 service.

Deploy the v2 Worker, migrations 143 through 145, and a v1 service revision with
`AGENT_V2_COMPAT_API_KEYS` on every ingress instance. The value is a JSON map
from destination tenants to their v2 API keys. Keep those keys in the service's
secret store. `AGENT_V2_COMPAT_URL` selects the v2 API and defaults to
`https://run.camelai.com/v2`.

For a verified client and an idle or finishing v1 agent, provision its private
v2 destination and use the same connection variables as the importer.

```sh
node --experimental-strip-types v2/scripts/move-agent.ts \
  <v1-tenant> <v1-agent-id> <operation-uuid> <v2-agent-id>
```

On `deferred`, rerun the same operation after the v1 work settles. For a
workspace migration, hold volume edits across all writers before moving the
agent and pass `--initial-commit`. Pass `--previous` after staging its history.
The command fences v1 admission, verifies the final copy, and publishes the
destination. A copy failure releases the fence. If publication is interrupted,
retry with the same operation ID to read the authoritative route. Publication
also saves the existing request receipts in the same transaction so older
request IDs remain readable without ECS.

The ingress can bind to the `LegacyV1` entrypoint exported by
`backends/workers/src/legacy-entry.ts`. Its default HTTP handler returns 404.
It answers agent listings and mount reads from the Node
database. It serves the supported prompt, request, state, event, and history
routes for a published agent, including the scoped `/clients` routes. With `LEGACY_ECS_FALLBACK=0`, a null result on `/v1`, `/clients` or `/mcp` returns HTTP 410. Authentication, storage, and upstream failures return an HTTP error.

Use a Hyperdrive binding to the Node Postgres schema with query caching
disabled. Give its role read access to `tenants`, `api_tokens`, `oauth_tokens`,
`oauth_grants`, `console_sessions`, `account_deletions`, `agents`, `actor_owners`, `runtime_nodes`,
`workspace_assignments`, `agent_v2_cutovers`, `agent_v2_routes`,
`agent_v2_receipt_archives`, and `agent_v2_requests`. Prompt receipt
reservation also needs insert access to `agent_v2_requests`. The migration
command uses its own database role to publish routes and receipt archives.
Apply `backends/workers/ops/legacy-credit-reads-grants.sql` before routing
end-user detail reads to the Worker. A detail read can settle an expired
credit lot and enqueues the same ledger and webhook records as the Node route.
Use the existing v1 operator configuration and session signing secret for
compatibility authentication. Connect `V2_LEGACY_RUNS` to the v2 Worker's
`LegacyAgentRuns` service entrypoint. Only the compatibility Worker needs this
binding. It verifies the published destination's tenant and agent and uses the
agent's existing v2 permissions for runs, history, and events.

When `MCP_LEGACY_API` is bound to the ingress's named `LegacyOrigin` entrypoint,
`LegacyV1` also serves `/mcp` and its OAuth discovery metadata. MCP retains
the v1 bearer authorization and configured issuer. The generated MCP tools
call the compatibility endpoints when available. Unsupported MCP tool calls receive the same HTTP 410 from the named entrypoint. Discovery and supported OAuth routes continue to use the existing issuer.

Keep the v1 ingress and its archived request store reachable during the
transition. Confirm older clients can complete their production workflows
through an ingress independent of the ECS service before retiring ECS.

The private volume origin uses the existing v1 credentials, volume IDs,
tenant checks and signed links. `LEGACY_VOLUMES_ROLLOUT` selects all methods
for `all` or an explicit comma-separated volume allowlist.
`LEGACY_VOLUMES_READ_ROLLOUT` independently selects only `GET` requests with
the same values. An explicit list selects individual volumes and their signed
links; only `all` also selects the volume collection. Leave the read selector
unset to retain current routing. A selected origin failure returns an error
without retrying another owner. These selectors do not start background jobs
or move storage away from AWS.

## Batch prepared Camel Bots builders

Run `v2/scripts/move-camel-bots-builders.ts manifest.json` to stage a batch.
Each entry names `owner`, `source` (the existing public agent ID),
`destination` (the prepared v2 agent ID), and a unique `operation` UUID.
Also include `initialCommit` for the target workspace and `draftVolumeId`
if the builder has a shared draft mounted. Include `attachments` for any
history messages with linked files. Each linked file needs a pinned commit
at its original workspace path. Prepare each target with the builder's normal
model, instructions, signed owner identity, and `/builder/mcp/v2` tools
before staging. Supply `V1_URL`, `V1_API_KEY`, `V1_TENANT`, `V2_URL`,
`BUILDER_V2_TENANT` (the app deployment's JSON secret), `CAMEL_BOTS_ORIGIN`,
`CAMEL_BOTS_DATABASE_URL`, and the runtime database connection.

Store the returned history receipt as `previous` in the same manifest entry.
Run with `--apply` after deploying the app's admission wait and placing
independent workspace edits behind the app's owner lock. The tool waits
for a later invocation when work remains active. It briefly holds app
admission, takes the runtime's durable idle fence, catches up the copy,
then publishes both routes. A published runtime route can be finished by
running the same manifest and operation again. Keep the original UUID and
receipt. A new request whose wait expires can retry using its original web
message ID. Shared drafts stay in their existing app-owned volume.

## Switch one cohort

- Keep the v1 client and v2 client connected at the same time. Route by bot and
  builder, including draft collaborators and shared workers. Use fresh v2
  credentials. Select the client from the same cutover record that holds the
  resource IDs.
- Copy files and history while v1 serves. Confirm that every saved or release
  snapshot referenced by Camel Bots has an imported commit and that the v2
  agent sees the expected history and files.
- Gate new edits and turns for the cohort. Let accepted turns settle on v1.
  Catch up the last file and history changes. Record the source sequences and
  switch the app's routes together, then release the queued work on v2.
- Verify a streamed turn, signed tool call, edit, save, release, and restore.
  Released bot bundles continue serving Discord throughout. Keep v1 data
  available for recovery. After v2 accepts new writes, reconcile its changes
  before switching a cohort back.

## Copy text conversations

With the same environment as the workspace importer, read a v1 agent's history
and import it into an existing, unused v2 agent.

```sh
node --experimental-strip-types v2/scripts/migrate-history.ts \
  <v1-agent-id> <v2-agent-id> [previous-receipt]
```

Keep the returned receipt. A retry of the same copy returns it again. To copy
a changed conversation, pass the prior receipt after the source turn drains.
The destination refuses imports after it has activity. The importer preserves
the original messages, including sender metadata and tool records, and maps
text and completed tool calls into v2 model context. A missing source page,
an unanswered tool call, or an inline image block makes the import fail before writing.

For attachments stored as workspace files, copy their bytes into the
destination repository before importing the history. Pass
`--attachments manifest.json` with a JSON array of entries containing
`messageIndex` (the zero-based v1 history index) and `files` (each with a
`path`, `commit`, and `contentType`). The destination checks each file at its
commit and retains the pinned reference. A missing file fails the whole import.

## Runtime tool authentication

Set `TOOL_IDENTITY_ISSUER` to the v2 base including `/v2` and supply
`TOOL_IDENTITY_PRIVATE_JWK` as a Worker secret containing a separate Ed25519
private JWK with a `kid`. The tool verifier uses that v2 base and the v2 tenant
ID. The Worker publishes only the public JWK at `/v2/.well-known/jwks.json`.
Set the verified bot owner and context as the agent's `toolIdentity` and
configure its MCP server with `auth: { type: "runtime" }`, the app's audience,
and the allowed tool names. The application still checks bot ownership and
the agent mapping before dispatching a tool.

Signed MCP servers can request tool approval using `needsApproval` in
`serveTools`. The runtime pauses and signs approval for the original call
only after a tenant credential submits an affirmative answer. A server can
also ask for a form or a URL step. Return form fields as an object in `answer`
or send `approved: false` to decline. The runtime resumes the call with its
original idempotency key. Keep the tenant credential in the application server.

## Send new attachments

Write the attachment to the agent's repository with `repos.write`. Pass the
resulting commit and the file path and media type as a `files` entry on
`agent.run`, `agent.submit`, or `agent.stream`. The reference is saved with the
queued turn. The agent receives the path and commit for reading the exact
version with `read_file` and receives supported images as model input. The
history API retains the references. Keep attachments reachable in the
repository. Large images are rejected before the turn is added to history.
Older images outside the model request budget remain readable by their
path and commit.

## Credit for the canary

If the canary can grant extra credit, provision a v2 tenant for each
participating owner and set a one-time initial balance. Route the selected
owner's builder and bots to that tenant. Use the v2 billing summary for
their canary usage. Only an admin can add credit, and repeated grants
with the same reference apply once. Each owner's existing v1 balance
continues to fund their v1 activity.

Keep paid balances, daily allowances and expiring lots on v1 during
the canary. The v2 balance check at run start is a spending threshold.
A run that starts with a positive balance can spend past it. At final
cutover, carry remaining paid credit over once v1 usage ends.

The live canary also needs app routing, shared draft access, attachment
manifest generation, and rendering the v2 tool inputs in Camel Bots.
