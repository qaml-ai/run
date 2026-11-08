### Sub-agents get no computer unless asked

When `computer` is left out of `delegate` or `spawn_agent` (also from code), the new sub-agent now gets no computer:
`"none"`, where it used to be `"fresh"`. A child of your own design (`instructions`) has no computer tool and no
computer settings. A child made from a definition that declares its own computer (Workers backend) keeps that
computer; a definition without computer settings gets none. `"fresh"` (a new, empty computer with the parent's
settings) and `"fork"` still work when asked for explicitly. Agents that relied on children inheriting the parent's
computer by default should pass `computer: "fresh"` or `"fork"`.
