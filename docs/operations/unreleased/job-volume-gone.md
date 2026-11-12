### Jobs: a job at a volume that is gone says why

`job_run` and a workflow's `job()` with `at` naming a volume that does not exist or was deleted now fail with "No volume
<id>: it does not exist or was deleted (a workflow's forks are deleted when the workflow ends; …)" instead of a bare
`FILE_404:Unknown volume`. An agent that reads a finished workflow's result and runs a job on a child's fork now learns
that the fork went with the workflow.
