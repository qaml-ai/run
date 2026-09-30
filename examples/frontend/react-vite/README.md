# react-vite

`<AgentChat>` in a Vite + React app, with the route in a plain Express server (`createAgentHandler`), and
`get_weather` drawn by a component of its own. The API key stays in the server; the browser streams from the
runtime with a short-lived token the route mints.

```sh
npm install
export CAMELAI_API_KEY=art_...   # and CAMELAI_MODEL=provider/model if you want another model
npm run dev          # http://localhost:3000
```

The sign-in is a demo (the browser sends a random id): replace `authorize` in `server.ts` with yours. With
Hono instead of Express: `app.post("/api/agent", c => handler(c.req.raw))`. For Next.js, start from
`npm create @camelai/run-app` instead.
