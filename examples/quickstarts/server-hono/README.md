# server-hono

A tiny HTTP API: one durable agent per user, each request streamed back as server-sent events. `requestId` is the
run's idempotency key, so a client that retries never starts a second run: it gets the first one's result.

```sh
npm install
export CAMELAI_API_KEY=art_...
npm start
```

```sh
curl -N localhost:3000/chat -H 'Content-Type: application/json' \
  -d '{"user":"alice","text":"Three tips for commit messages","requestId":"req-1"}'
```

```
event: text
data: "1. **Lead with a clear"
…
event: done
data: {"status":"completed","text":"1. **Lead with a clear, concise summary** …"}
```

Send the same `requestId` again and you get the same `done`, without a new run.
