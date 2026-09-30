# Frontend examples

Each is a chat with an agent in the browser, over one route in your server (`createAgentHandler`), against
https://run.camelai.com with your API key. See the [Frontend guide](../../docs/frontend.md).

| Example | Shows |
| --- | --- |
| `npm create @camelai/run-app` | Next.js: `<AgentChat>`, the route, and a tool drawn by its own component (the starter) |
| [react-vite](react-vite) | Vite + React, `<AgentChat>`, the route in Express, a custom tool card |
| [vue](vue), [svelte](svelte), [solid](solid) | the same chat with each framework's bindings |
| [proxy](proxy) | read-proxy mode: the browser only talks to your origin (Hono) |
| [ai-sdk](ai-sdk) | the AI SDK's `useChat` with `AgentRuntimeChatTransport` |

Each runs with `npm install`, `export CAMELAI_API_KEY=art_...`, `npm run dev`.
