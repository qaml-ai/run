### A prompt's own model

`model` on `POST /v1/agents/{id}/prompt` runs that turn on another model of the agent's provider, on the same history,
tools and settings; the agent's model (and compaction's) is unchanged. It is the tenant's to set, is kept on the
request record (`model`) for the turn's resume after human input and its continuation on another node, and is refused
(400) for another provider, an unknown model, settings the model takes none of, or `whileRunning: "steer"`. The
TypeScript SDK takes it on `agent.run`/`stream`/`send`, `client.prompt`/`submit`, and from an agent handler's
`onSend` (`{ model }`). See [Concepts](../concepts.md#a-run-on-another-model).
