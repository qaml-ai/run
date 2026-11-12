### `job_run`: an agent runs one command in a container of its own

On the Workers backend, wherever workflows and a job driver exist (the Cloudflare pilot), every agent now has a `job_run`
tool. It runs one shell command in a fresh container through the same job driver as a workflow's `job()`, and waits up
to 15 minutes:

- the command can start from a volume's files (`at`) or from small inline files (`files`);
- outputs written under `$JOB_OUT` are returned inline;
- the result is the exit code and the end of stdout/stderr.

The job is metered as the agent's own computer time, against its spend limit. A replayed tool call doesn't run the
command again. For agents that have `job_run`, `workflow_start`'s description now says to use `job_run` rather than a
workflow for a single command: in eval #821, an agent started 92 workflows only to run commands.
