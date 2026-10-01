# Agent app

> **⚠ Add your own sign-in before you deploy.** This starter's sign-in is a demo: every browser gets
> an anonymous user id, so anyone who can reach the app can use your agents (and your API key's
> credit). In production (`next build && next start`, or any host) the route refuses everyone until
> you replace `authorize` in `app/api/agent/route.ts` (and `proxy.ts`) with your auth, or opt in to
> anonymous demo users with `DEMO_AUTH=1`.

A Next.js app with a streaming chat to an agent on [camelRun](https://run.camelai.com).

```sh
cp .env.example .env.local   # add your CAMELAI_API_KEY (https://run.camelai.com/console/tokens)
npm install
npm run dev                  # http://localhost:3000
```

The agent uses your account's default model. To choose another, set `AGENT_MODEL` in `.env.local` to
one your account can use: `npx -y @camelai/camelrun models --available` lists them.

Coding agents working in this app: see `AGENTS.md`.

- `app/api/agent/route.ts`: the route the chat talks to (`createAgentHandler`). It keeps your API key on
  the server, makes each user their own agent, and defines its instructions and tools. Replace the demo
  sign-in in `authorize` (and `proxy.ts`) with yours.
- `app/components/chat.tsx`: the chat (`<AgentChat>`), with `get_weather` drawn by your own component.
  Theme it with CSS variables (`--agent-accent`, `--agent-radius`, …), or build your own UI with the hooks
  in `@camelai/run-react` (`useMessages`, `useSend`, `useAgentStatus`, `useInputs`).

Tools in `route.ts` run inside this server, so they need a long-running process (`next dev`,
`next start`, a container). On serverless hosting, serve them with `serveTools` (with your `tenant`) from
`@camelai/run/server` and name them in a definition (`agent: { definition: "def_…" }`).
