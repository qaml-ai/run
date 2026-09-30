# Showing an agent in a browser

A browser reads an agent directly from the runtime (its messages as they stream,
the running turn, tool progress, waiting inputs, older history) with a **browser
token** your server mints for each user after its own access checks. The browser
never holds your API key or the agent's token, and your server relays nothing.

## 1. Mint a token on your server

```ts
// POST /api/threads/:id/token, after checking the user may see this thread
const agent = await agents.upsert(`thread-${threadId}`, config);
return Response.json(await agents.runtime.browserToken(agent.id, { ttlSeconds: 900 })); // { token, expiresAt, agentId, url }
```

(Python: `await agents.runtime.browser_token(agent.id, ttl_seconds=900)`; REST:
`POST /v1/agents/:id/browser-tokens {ttlSeconds?, scopes?, events?, redact?, subject?}`.)

- The token reads that one agent: only `GET /v1/agents/:id/events`, `/state`,
  `/history` and `/inputs` (or the `scopes` you name). Everything else is a 403.
- It lasts `ttlSeconds` (default 900, 5 to 3600), and its event stream ends when
  it expires. It is stateless: nothing revokes it sooner, so keep it short.
- `events` limits the event types it gets (the watcher needs `turn_opened`,
  `message_start`, `message_update` and `message_end` to follow messages);
  `redact: ["usage.cost"]` leaves provider costs out of everything it reads. It
  never gets the runtime's internal events, or a run's result, only whether and
  why a run stopped.
- It works from any origin, as publishable keys do: the token grants the read,
  so there is no origin list to keep. Send it as `Authorization: Bearer`, never in
  a URL.

## 2. Watch from the browser

```ts
import { watchAgent } from "@camelai/run/watch";

const { token, expiresAt, agentId, url } = await fetch(`/api/threads/${id}/token`, { method: "POST" }).then(r => r.json());
const watcher = watchAgent({
  url, agentId, token, expiresAt,
  // Called before the token expires, and if the runtime refuses it.
  getToken: () => fetch(`/api/threads/${id}/token`, { method: "POST" }).then(r => r.json()),
  onChange: state => render(state),
  onError: error => console.warn(error.message),
});
// later: watcher.loadOlder() on scroll-up; watcher.close() when the view goes away
```

`@camelai/run/watch` has no dependencies and no Node APIs (it bundles
to under 30 KB). `state` is:

| field | |
| --- | --- |
| `messages`, `indexes` | the agent's messages, oldest first, each at its index in the history; a user message carries its `requestId` and your `metadata`, to match an optimistic bubble |
| `partial` | the assistant message streaming now, with tool calls' arguments parsed as they stream |
| `progress` | the latest progress of each running tool call, by tool call id |
| `running` | whether a turn runs |
| `pendingInputs` | inputs the agent waits on (answer them through your server) |
| `lastOutcome` | how the latest run ended: `{id, stopped?, error?}` |
| `hasOlder` | whether `loadOlder()` has more |
| `connected`, `transport` | `sse`, or `poll` where a proxy buffers streams |
| `expired` | the token expired (or was refused) and could not be renewed: the watcher stopped; watch again with a new token |

- It streams over SSE and falls back to long polls where streams deliver
  nothing. It reconnects from its cursor, or from a snapshot of the running turn
  where it cannot replay, and closes the stream while the page is hidden
  (`hiddenGraceMs`, default 30 s).
- Without `getToken`, the watcher stops when its token expires, with
  `state.expired` set and an error saying so. Pass `getToken` for any view that
  stays open longer than the token.
- In a browser a network failure and a CORS refusal both look like "Failed to
  fetch"; the watcher's error says which to check. The usual cause is a token
  that is not a browser token (the runtime allows cross-origin reads only with
  one), or a wrong `url`.

## Sending messages from the browser

The browser only reads. Send messages, answers and aborts through your server,
which checks the user and calls the agent:

```ts
// POST /api/threads/:id/messages
const agent = await agents.upsert(`thread-${threadId}`, config);
const run = await agent.run(text, { user: user.id, metadata: { clientId } });
return Response.json({ reply: run.text });
```

The watcher shows the run as it happens; `metadata.clientId` lets the page match
the stored user message to the bubble it showed optimistically.

## Ready-made components

The runtime serves a [shadcn](https://ui.shadcn.com) registry of React components: a streaming
chat with the user's agent, with tool cards, questions and approvals, and files (`agent-chat`); its
safe, streaming-tolerant Markdown (`agent-markdown`); and the Next.js App Router route the chat
talks to, which keeps your API key on the server and lets each user reach only their own agent
(`agent-route`). Add one to your app with its URL:

```bash
npx shadcn@latest add https://agents.camelai.dev/r/agent-chat.json
```

`/r/registry.json` lists them. The registry is public and cacheable; a self-hosted runtime serves
its own at `<its URL>/r/`.

## Without the watcher

The same reads work from any code: `GET /v1/agents/:id/events` (SSE; `?poll=1&wait=25`
for one JSON long poll), `/state`, `/history?limit=50` (pages of whole turns,
newest first, `before` for older) and `/inputs`, with a browser token or your
API key. See the [event reference](../reference/events.md).
