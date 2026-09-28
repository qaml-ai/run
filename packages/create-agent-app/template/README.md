# Agent app

A Next.js app with a streaming chat to an agent on the [camelAI agent runtime](https://agents.camelai.dev).

```sh
cp .env.example .env.local   # add your CAMELAI_API_KEY
npm install
npm run dev                  # http://localhost:3000
```

- `app/api/agent/route.ts`: the route the chat talks to (`createAgentHandler`). It keeps your API key on
  the server, makes each user their own agent, and defines its instructions and tools. Replace the demo
  sign-in in `authorize` (and `proxy.ts`) with yours.
- `app/components/chat.tsx`: the chat (`<AgentChat>`), with `get_weather` drawn by your own component.
  Theme it with CSS variables (`--agent-accent`, `--agent-radius`, …), or build your own UI with the hooks
  in `@camelai/agent-runtime-react` (`useMessages`, `useSend`, `useAgentStatus`, `useInputs`).

Tools in `route.ts` run inside this server, so they need a long-running process (`next dev`,
`next start`, a container). On serverless hosting, serve them with `serveTools` (with your `tenant`) from
`@camelai/agent-runtime/server` and name them in a definition (`agent: { definition: "def_…" }`).
