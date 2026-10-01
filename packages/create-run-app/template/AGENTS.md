<!-- BEGIN:camelrun-agent-rules -->
# camelRun

This app runs an agent on camelRun (https://run.camelai.com): the runtime runs the model loop and keeps each agent's
history and files, and the agent's tools are ordinary functions in this server. The `@camelai/run` SDK changes faster
than your training data. Before writing agent code, read `node_modules/@camelai/run/docs/SKILL.md` and
`node_modules/@camelai/run/docs/sdk.md` (the docs for the installed version), or https://run.camelai.com/llms.txt.

- `app/api/agent/route.ts` is the route the chat talks to (`createAgentHandler` from `@camelai/run/server`). It
  defines the agent's instructions and tools, and `authorize`, the sign-in (a demo: replace it, and `proxy.ts`,
  before deploying).
- `app/components/chat.tsx` is the chat (`<AgentChat>` from `@camelai/run-react`), with each tool's own component.
- `CAMELAI_API_KEY` is server-only, in `.env.local`. Never put it in browser code or a `NEXT_PUBLIC_` variable, and
  never ask for it in chat: the user creates one at https://run.camelai.com/console/tokens and adds it themselves.
- The agent names no model, so it gets the account's default. `AGENT_MODEL` chooses another
  (`npx -y @camelai/camelrun models --available` lists the ones the account can use).
- Tools run in this server while `next dev` or `next start` runs. On serverless hosting, serve them with
  `serveTools` and a definition instead (see README.md).
- To see what an agent did, use `npx -y @camelai/camelrun history <agent>` and `runs get`, or the console at
  https://run.camelai.com/console/agents, rather than throwaway scripts.
<!-- END:camelrun-agent-rules -->
