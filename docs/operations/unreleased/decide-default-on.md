### The decide tool is on by default

Every agent now has the `decide` tool (decisions with a decision model, `docs/guides/decisions.md`), directly and from
js_exec as `tools.decide`, without listing it in `builtins`. Exceptions: an agent with no js_exec and no tools of its
own, and a run with no tools at all, have none unless they send `decide: true`; it is not offered on an account with no
OpenRouter key decisions can use (an agent whose `dataCollection` is `deny` has it, its calls sent with that policy).
Opt out with `decide: false` on an agent (create or `PATCH .../configuration`; `null` restores the default), a
run, or a definition; the agent view shows the setting (`decide`: true, false or null). The tool adds about 300 tokens
to each request's tool list, so each agent's next request misses the prompt cache once. Calls are billed like any
decision: on the platform's key, to prepaid credit.
