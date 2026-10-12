### Schedules without history

- A text schedule takes `history: "none"` (REST, the SDKs' `schedule`, the `schedule` built-in, `camelrun schedules
  add --history none`, the MCP server's `add_schedule`): each wake-up shows the model only the system prompt and the
  schedule's text, as a prompt's `history: "none"` does, so a periodic agent no longer reads an ever longer history on
  every run. The runs are still recorded in the history. Schedules list it as `history: "none"`; the default is
  unchanged ([Waking later](../concepts.md#waking-later)).
