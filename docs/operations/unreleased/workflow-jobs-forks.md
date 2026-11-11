### Workflows: job(), forked children, commit() and push()

On the Workers backend (pilot), a workflow script can now:

- give a child its own copy of a volume to edit: `agent(prompt, { repo: volumeId })` mounts a metadata-only fork of the
  volume at `/repo` (no bytes copied) and answers `{ text, fork }`;
- land a child's edits on the volume with `commit(result.fork)`: every changed or removed file in one atomic commit,
  checked against the version the fork started from, or `{ committed: false, conflicts: [{ path, headVersion }] }` with
  nothing written when the volume changed under any of them;
- run a command in a container of its own with `job({ command, timeoutSeconds, at: volumeId, files?, outputs?, limits? })`,
  under the workflow's `jobConcurrency` (default 8) and the account's job cap. Its outputs and full stdout/stderr are kept
  in the workflow's volume under `/jobs/<id>/`; the script gets the exit code, each stream's end and the files' paths;
- push a volume to a GitHub branch with `push({ volume, repo, branch, app })`, a job that uses the GitHub App's
  installation token without the script or any model seeing it.

A job is paid by the agent that owns the workflow (the one that started it with the workflows builtin), with its
metering and spend limits, once per job however often it is run again; its cost also counts against the workflow's
budget. A workflow started with an API key has no owner agent, and its `job()` fails with `job_payer_unavailable`.
Jobs need Cloudflare Containers, on the pilot only for now: elsewhere `job()` fails with `JOBS_UNAVAILABLE`.
