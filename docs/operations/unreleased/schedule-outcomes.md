### Stored schedule outcomes and bounded retention

Schedule deliveries now return stored run state, run ID, error and USD cost instead
of fetching each agent. `state` describes the run; email status moves to
`emailState` and `emailError`. The embedded `record` field is removed.

Delivery summaries expire after 30 days. Fresh schedules require at least five
minutes between triggers and allow at most 200 unexpired run agents per schedule.
Continue-mode Workers schedules submit locally even while reporting storage is
unavailable or its migration has not run. Code schedules reject per-run budgets.
