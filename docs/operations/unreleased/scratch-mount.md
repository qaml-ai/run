### Volumes: the agent's workspace at a path of its own

- `{workspace: true, path: "/scratch"}` mounts the agent's own workspace at that path, so a project volume can sit
  at /workspace beside it. Attachments (`uploads/<request>/`), tool outputs, saved long tool results, the prompt's
  environment text and js_exec's example all follow the workspace wherever it is; forks keep it at the same path.
  The path must be absolute, normalized and clear of the other mounts. SDK types: `MountInput` (TypeScript), `Mount`
  and `WorkspaceMount` (Python).

### Mount changes during a turn

- Fix: mounts changed while the agent was running (`PUT /v1/agents/:id/mounts` mid-turn, or an upsert's
  `remount: true`) never reached its prompt: its environment text named the old mounts until the agent happened to
  restart. Now the next run restarts it with the current mounts, and its prompt describes them.
- Mount changes apply at the agent's next tool call (a call under way keeps the mounts it began with): a removed
  volume is refused, a read-only one is read-only, an added or swapped-in one is usable at its path. MCP and other tool
  outputs follow too; before, they could still be saved to a volume unmounted since the agent started.
- Fix: forking an agent whose workspace was left out (`{workspace: false}`) gave the fork a new workspace at
  /workspace.
