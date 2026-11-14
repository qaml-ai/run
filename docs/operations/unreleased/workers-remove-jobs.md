### Workers workflows and agents drop the job interface

Workers agents lose `job_run`, and workflow scripts lose `job()` and
`push()`. Use child agents to fan out work and their `bash` tool to run
commands. Workflows still merge child branches with `commit()`.
