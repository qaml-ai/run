### Monitors: checks that wake an agent only when something happens

A monitor is a repeating code schedule whose script decides whether to wake the agent. Every `everySeconds`
(default 300, at least 60) the runtime runs the check with the agent's code tools; it reads `state` and returns
`{ fire, value?, state?, nextSeconds? }`. A check that does not fire starts no turn and uses no model tokens. A fire
queues one message to the agent with `value` framed as data. `mode: "once"` stops after the first fire; `"repeat"`
fires again only when `value` changes.

The `monitor` builtin gives an agent `monitor_start`, `monitor_stop` and `monitor_list`. The API is
`/v1/agents/{id}/monitors` (create, list, get, stop, and `/checks` for the last 20 checks); the TypeScript and Python
SDKs and `camelrun monitors` mirror it. Both backends.

Guardrails: 20 monitors an agent, expiry (a day by default, 30 days at most), a check gets no tool that starts model
work, asks a person or uses a computer, and 10 seconds; failing checks back off and stop the monitor after 10 in a
row with one message; more than 12 fires in an hour pause it with one message; an occurrence is skipped while the last
check still runs. Approvals asked by a check or by the turn a fire starts are declined.

Migration `134_schedule_monitors.sql` adds one nullable column (`schedules.monitor`); nodes on the previous release
are unaffected during a rolling deploy. See `docs/guides/monitors.md` and `docs/design/monitors.md`.
