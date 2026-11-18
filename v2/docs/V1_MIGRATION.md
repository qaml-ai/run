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

The two clients use different run, tool, file, and voice interfaces. The v1
SDK's server entry point verifies Camel Bots' signed tool calls. The v2 client
needs equivalent tool identity and shared draft access before it can serve
builder traffic. A live rollout also needs history and attachment import and a
single credit authority that enforces the same balance, expiry, allowance and
hold rules for both clients. The file importer covers only the workspace copy.
