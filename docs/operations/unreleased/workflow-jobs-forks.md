### Workflows: job(), children on branches, commit() and push()

On the Workers backend (pilot), a workflow script can now:

- give a child its own branch of a repo to edit: `agent(prompt, { repo })`, where `repo` is a repo id or
  `{ repo, ref? | version? }` (default `main`), mounts a branch made for that child at `/repo` and answers with
  `fork: { repo, ref, base: { ref?, version } }`;
- land a child's edits with `commit(result.fork)`: a merge of the child's branch onto its base ref, answering
  `{ committed: true, version, changed, files? }`, or `{ committed: false, conflicts }` with nothing written. A fork of a
  bare `version` has no ref to merge into;
- run a command in a container of its own with `job({ command, timeoutSeconds, at, files?, outputs?, limits? })`, where
  `at` is `{ repo, ref? | version? }` or a volume id, under the workflow's `jobConcurrency` (default 8) and the account's
  job cap. Its outputs and full stdout/stderr are kept as one commit under `jobs/<id>/` in the workflow's repo; the
  script gets the exit code, each stream's end, the files' paths, and the `repo` and `version` that hold them;
- push a volume to a GitHub branch with `push({ volume, repo, branch, app })`, a job that uses the GitHub App's
  installation token without the script or any model seeing it.

A workflow's branches are deleted when it ends, once its commits have landed. A cached result whose child edited a
branch keeps that version for 3 days through a ref of its own.

A job is paid by the agent that owns the workflow (the one that started it with the workflows builtin), with its
metering and spend limits, once per job however often it is run again; its cost also counts against the workflow's
budget. A workflow started with an API key has no owner agent: its jobs are paid by its account, admitted by the
account's monthly spend limit and prepaid credit (its balance, as a fresh run checks it: credit holds are not subtracted), and recorded under the workflow's id (`usage` rows,
usage details with the workflow as agent and root, one receipt per job run, however often it is run again). A job
they refuse pauses the workflow with `payer_exhausted`.
Jobs need Cloudflare Containers, on the pilot only for now: elsewhere `job()` fails with `JOBS_UNAVAILABLE`.

An agent saved with a volume mount (`volumeId`) is refused with a 409 naming the volume and the fix: remount it to a
repo with `PUT /v1/agents/:id/mounts` and `remount: true`.
