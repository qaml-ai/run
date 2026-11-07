### `delegate.notify: "asap"`: a sub-agent's ending joins the parent's running turn

A definition's or agent's `delegate` takes `notify`: `"turn"` (the default, as before) or `"asap"`. With `"asap"`, a
background sub-agent's ending that reaches a parent whose turn is running joins that turn at its next step, after the
tool results it waits for, instead of waiting for the turn to end and starting one of its own. The notification's
request ends with `result.steeredInto`. A `wait_agent` in flight still takes the ending into its result. Exactly once,
on Node and Workers alike: the ending is landed (claimed, its batch, charged) before it is offered, and one the turn
does not take runs as its own turn with what it landed. `spawn_agent`'s description says so when it is on. See
`docs/guides/multi-agent.md`.
