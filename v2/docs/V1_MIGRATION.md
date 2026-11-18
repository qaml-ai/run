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
