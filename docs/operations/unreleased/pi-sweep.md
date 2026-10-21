### Pi migration sweep

`AGENT_PI_SWEEP=dry-run|on` (off by default) walks retained agents still on the legacy engine, one
at a time on one node, after the node starts. `dry-run` logs what each agent's next open would do
(`would_migrate`, or `deferred_<reason>`) without opening or writing anything; `on` opens each idle
agent that no node holds, so it migrates exactly as a lazy open would, and unloads it again. Agents
with runs open, waiting on human input or loaded anywhere are left for their own next open. The
admin health page gains an "Agents on the legacy engine" count.
