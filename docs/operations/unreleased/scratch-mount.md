### Volumes: the agent's workspace at a path of its own

- `{workspace: true, path: "/scratch"}` mounts the agent's own workspace at that path, so a project volume can sit
  at /workspace beside it. Attachments (`uploads/<request>/`), tool outputs, saved long tool results, the prompt's
  environment text and js_exec's example all follow the workspace wherever it is; forks keep it at the same path.
  The path must be absolute, normalized and clear of the other mounts. SDK types: `MountInput` (TypeScript), `Mount`
  and `WorkspaceMount` (Python).

### Mount changes during a turn

- Fix: mounts changed while the agent was running (`PUT /v1/agents/:id/mounts` mid-turn, or an upsert's
  `remount: true`) never reached its prompt: its environment text named the old mounts until the agent happened to
  restart, while its file tools used the new ones. Now a turn loses a removed mount at once and keeps the others it
  began with, MCP tools' file outputs included (they could still be saved to an unmounted volume); the next turn
  restarts the agent with the new mounts and its prompt describes them.
- Fix: forking an agent whose workspace was left out (`{workspace: false}`) gave the fork a new workspace at
  /workspace.
