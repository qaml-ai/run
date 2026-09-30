# vue

A chat with an agent in Vue 3, with `useAgentChat` from `@camelai/run-vue` (refs for the messages, status and inputs, and the actions). The route is `createAgentHandler` in a plain Express server; the API key stays there, and the browser streams
from the runtime with a short-lived token the route mints.

```sh
npm install
export CAMELAI_API_KEY=art_...   # and CAMELAI_MODEL=provider/model if you want another model
npm run dev          # http://localhost:3000
```

The sign-in is a demo (the browser sends a random id): replace `authorize` in `server.ts` with yours.
