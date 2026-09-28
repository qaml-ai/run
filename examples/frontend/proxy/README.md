# proxy

`<AgentChat>` with the route in read-proxy mode (`createAgentHandler({ proxy: true })`, here in Hono): the
browser reads its agent's stream through your route too, so it only ever talks to your own origin (no runtime
URL in the page, nothing to allow in a Content Security Policy). The chat itself needs no change.

```sh
npm install
export CAMELAI_API_KEY=art_...   # and CAMELAI_MODEL=provider/model if you want another model
npm run dev          # http://localhost:3000
```

Each open chat then holds a request on your server; serverless functions cut it at their time limit (the chat
reconnects, and falls back to long polls). Without a reason to proxy, read directly (the default). The sign-in
is a demo: replace `authorize` in `server.ts` with yours.
