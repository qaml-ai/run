### Background sub-agents: shares, limits alone, notices

- A background sub-agent's run gets a share of its parent agent's spend limit: what no running sub-agent holds, split
  evenly among the slots `maxParallel` leaves. Sub-agents started together (by `spawn_agent` or a tool's spawn
  directive) share it rather than each getting all of it. Migration 063 adds `agent_children.budget`.
- `delegate: { maxParallel, maxDepth }` alone, without the `delegate` or `agents` builtin, bounds the sub-agents an
  agent's tools start (`camelrun/spawn`) without giving the model a tool to start them.
- SDKs: a notice (`agentNotice`, `agent_notice`, the chat's `UserChatMessage.agent`) carries the notification's
  structured `output`, its `usage` and the `inputs` it waits on; `SubagentView.status` includes `aborted`; and
  `createAgentHandler`'s `browserToken.scopes` chooses what its tokens read (add `children` for sub-agents).
