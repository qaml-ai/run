### Pi-owned recovery of interrupted runs (canary)

`AGENT_PI_RECOVERY_TENANTS` (comma-separated tenant ids, or `*`; unset: nobody) lets Pi resume a run whose node was
lost, from its own checkpoint, instead of the host aborting Pi's run at load and repairing the turn itself. For those
tenants, a run lost mid-request asks the model again (the cut-off partial response is not kept); a tool call that was
running is answered as interrupted, in Pi's words ("Tool X was interrupted and may have partially run"), unless its tool
may run again (the delegation tools, as before). A run a closing node aborted (drain, retire, memory hand-off) and a
turn waiting on a person's input recover as before. `AGENT_MAX_RESUMES` and the sweep backoff still bound resumes.
Watch `task_parked` (`pi_report`), `resume_limit` outcomes and model attempts per resumed run.

Each run Pi resumes this way logs `pi_run_resumed` (agent, tenant).
