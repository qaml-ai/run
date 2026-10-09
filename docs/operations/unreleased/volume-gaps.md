### Volumes: the workspace beside other mounts

- **Changed:** an agent's own workspace now stays at /workspace beside the `mounts` it is given (after them), for
  uploads, tool outputs and scratch files; before, given mounts replaced it. `{workspace: false}` among the mounts
  leaves it out (`[{workspace: false}]` is no mounts at all; `[]` is now the workspace alone), `{workspace: true}` puts
  it at that position, and a mount given at /workspace takes its place. Stateless runs are unchanged: their own
  mounts are all they get. Chiridion (default workspace) and camel-bots (/bot beside the workspace) need no change.
- `remount: true` on an upsert sets the mounts it gives (between the agent's turns), where other mounts are a 409.
  SDKs: `upsert(key, { mounts, remount: true })`, Python `remount=True`.
- Fix: an agent whose mounts no longer include its own workspace (changed with `PUT /v1/agents/:id/mounts`) left that
  volume behind when it was deleted. It is deleted with the agent now.
- The SDKs' `createVolume({ name }, { idempotencyKey })` and Python `create_volume(idempotency_key=…)` send an
  `Idempotency-Key`: the same key makes the volume once (for a day).
- Docs: where uploads, tool outputs and scratch files go; deleting an agent takes your API key, never its own token.
