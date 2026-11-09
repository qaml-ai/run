### Workers: only agents with a computer get the computer tool

This is a behavior change on the Workers backend. Until now every agent of a deployment that binds computer
containers (`COMPUTER_CONTAINERS`) was offered the `computer` tool, whether or not it asked for a computer. Now an
agent has a computer only when one is declared for it:

- its definition has `computer` (`"computer": {}` is the default computer; `instance`, `idleSeconds`, `idle`,
  `egress` and `secrets` are its settings), or
- it is a sub-agent that was given one: it shares its parent's (`computer: "share"`), has a `"fork"` or `"fresh"`
  machine from a parent that has one, or is made from a definition that declares its own.

An agent without one is not offered the `computer` tool (by the model or from code), starts no container, and its
sub-agents default to `computer: "none"`: the "share when the parent has a computer" default uses the same rule, and
`"fresh"` or `"fork"` from a parent without a computer give the child nothing (`"fork"` answers `409 NO_SESSION`).
`POST /experimental/agents/{id}/computer` for such an agent answers `409 NO_COMPUTER` ("This agent has no computer:
add `computer` to its definition") instead of starting a container, and `POST /v1/agents/{id}/computer/fork` refuses
a target without a computer the same way.

**Action needed:** agents that relied on an undeclared computer must add `computer` to their definition
(`"computer": {}` is enough). `computer` is accepted on definitions only, so an agent made without a definition has
no native computer. Definitions that already set `computer` are unchanged, as are computer connections
(`/v1/computers`) and the Node backend, where computer tools have always needed an attached connection.
