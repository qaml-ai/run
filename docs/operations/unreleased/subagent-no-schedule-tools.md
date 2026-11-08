### A sub-agent is not offered the schedule tools

A sub-agent the runtime made from a definition with the `schedule` builtin was offered `schedule`, `list_schedules`
and `cancel_schedule`, and only its `schedule` call was refused (409 `SUBAGENT_VIA_PARENT`). On both backends those
tools are now left out of its tools; a schedule on it is still refused when it is made, as before.
