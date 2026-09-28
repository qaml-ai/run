# Frontend guide

Put a streaming chat with an agent in your app: your users talk to their own agents, the agent's
replies stream in as they are written, its tool calls show as cards (or as your own components), and
its questions and approvals are answered in place.

- [Start a new app](#start-a-new-app)
- [Add it to an app you have](#add-it-to-an-app-you-have): the route, then the UI
- [How it stays secure](#how-it-stays-secure)
- [The UI, four ways](#the-ui-four-ways): `<AgentChat>`, hooks, shadcn, AI SDK
- [Tools and generative UI](#tools-and-generative-ui)
- [Questions, approvals and files](#questions-approvals-and-files)
- [Conversations (threads)](#conversations-threads)
- [Theming and accessibility](#theming-and-accessibility)
- [Other frameworks](#other-frameworks)
- [Troubleshooting](#troubleshooting)

## Start a new app

```sh
npm create @camelai/agent-app my-app -- --api-key $CAMELAI_API_KEY
cd my-app && npm run dev
```

A Next.js app with the chat, its route, a tool drawn by its own component, and a demo sign-in to
replace with yours. Get an API key in the [console](https://agents.camelai.dev/console).

## Add it to an app you have

```sh
npm install @camelai/agent-runtime @camelai/agent-runtime-react
```

### 1. The route

One POST route on your server does everything the browser needs: it checks who the user is (your
own sign-in), gives their browser a short-lived token to read their agent, and sends their messages
and answers. Your API key never leaves the server.

```ts
// app/api/agent/route.ts (Next.js App Router)
import { createAgentHandler } from "@camelai/agent-runtime/server";

export const POST = createAgentHandler({
  // CAMELAI_API_KEY from the environment, or apiKey: "…"
  authorize: async request => {
    const user = await getUser(request);          // your session check
    return user ? { userId: user.id, name: user.name } : null;   // null: 401
  },
  agent: {
    instructions: "You help customers with their orders.",
    model: "anthropic/claude-sonnet-5",           // optional; any model from GET /v1/models
  },
});
```

The same handler is a standard `fetch` handler everywhere:

```ts
// Hono
app.post("/api/agent", c => handler(c.req.raw));

// Cloudflare Workers, Bun, Deno
export default { fetch: handler };

// Express or node:http
import { nodeListener } from "@camelai/agent-runtime/node";
app.post("/api/agent", nodeListener(handler));    // before any body parser for this route
```

`createAgentHandler` options:

| Option | |
| --- | --- |
| `authorize(request, { thread, action })` | Required. Return `{ userId, name?, agentKey? }` or `null`. |
| `agent` | How the user's agent is made: `{ instructions, model, tools, definition, context, spendLimit, … }`, or a function of the user. |
| `onSend({ auth, text, data, request })` | Before each message: return `{ text?, metadata? }`, or `throw new Response(…)` to refuse it (quotas, moderation). |
| `browserToken` | `{ ttlSeconds, events, redact, url }` for the tokens it mints (default 15 minutes, no provider cost). |
| `allowedOrigins` | Other origins whose pages may call the route (with CORS). |
| `linkAnyMountedPath` | `true`: file links for any path in the agent's mounts. Default: only files it presented, or in its own default `/workspace`. |
| `proxy` | `true`: browsers read their agent through this route too, and only ever talk to your origin (see [Reading through your route](#reading-through-your-route-proxy)). Default `false`. |
| `apiKey`, `url` | Default `CAMELAI_API_KEY`, and `CAMELAI_BASE_URL` or https://agents.camelai.dev. |

### 2. The UI

```tsx
"use client";
import { AgentChat } from "@camelai/agent-runtime-react/ui";
import "@camelai/agent-runtime-react/styles.css";

export default function Support() {
  return <AgentChat endpoint="/api/agent" suggestions={["Where is my order?"]} />;
}
```

`<AgentChat>` fills its container: give that a height.

### Reading through your route (proxy)

By default the browser reads its agent's stream straight from the runtime, with the browser token
your route gave it: the stream never passes through your server. With `proxy: true`, your route
passes those reads through as well (the event stream, its long-poll fallback, history, state and
inputs), so the browser only ever talks to your origin: nothing to allow in a Content Security
Policy, and no runtime URL in the page. The chat needs no other change.

```ts
// app/api/agent/[[...path]]/route.ts: the route and every path under it
const handler = createAgentHandler({ authorize, agent, proxy: true });
export const GET = handler;
export const POST = handler;
```

Hono: `app.all("/api/agent/*", c => handler(c.req.raw))` as well as `/api/agent`. Express:
`app.use("/api/agent", nodeListener(handler))`. Workers: the same `fetch` handler.

Each read is checked with `authorize` like everything else and must name the user's own agent; the
route adds a browser token it keeps on the server (the browser never sees one), and streams each
chunk as it arrives. A browser that goes away cancels the read upstream.

The cost: every open chat holds a request on your server for as long as it is open. Serverless
functions cut a request at their time limit (on Vercel, the function's maximum duration); the chat
then reconnects from where it was, and after two streams that deliver nothing it switches to long
polls of at most 25 seconds, which fit any limit. Direct reads keep that load off your servers, so
they stay the default: use the proxy when policy requires a single origin.

## How it stays secure

- **The API key stays on your server.** The browser gets a *browser token* for one agent: it reads
  that agent's events, history, state and inputs, for 15 minutes, and nothing else. It cannot send,
  answer, stop, or read another agent. The chat renews it through your route before it expires.
- **Every write goes through your route**, after your `authorize`. The browser never names an agent:
  the route picks the user's agent from what `authorize` returned (by default one per user and
  thread, `agentKeyFor(userId, thread)`, a hash that no user's thread name can collide with). An
  agent's `subject` is its user and cannot change afterwards.
- **Messages and answers are sent as the user** (`from: { id: userId, name }`), never as whatever the
  browser claims; the runtime checks answers against who may answer. The browser's own data for a
  message (`send(text, { data })`) reaches the agent only if your `onSend` passes it on.
- **Sends are idempotent**: each carries the id the browser gave its message, so a retry never sends
  twice.
- **Cross-site requests are refused**: the route takes only `application/json` (which a form on
  another site cannot post) and refuses `Sec-Fetch-Site: cross-site` unless you list the origin.
- **Rendering is safe**: markdown is rendered with elements, never HTML; links are only http(s) and
  mailto; images the model links are shown as links unless you set `allowImages` (loading an image
  a model chose can leak data to its server).

## The UI, four ways

**`<AgentChat>`**, prebuilt (`@camelai/agent-runtime-react/ui`): messages, streaming markdown, tool
cards, questions, files, a composer with Stop, scrolling that follows the reply. Replace any part:

```tsx
<AgentChat
  endpoint="/api/agent"
  tools={{ get_weather: WeatherCard }}                 // your component per tool
  components={{ Markdown: MyMarkdown, EmptyState: Welcome }}
  labels={{ placeholder: "Ask about your order" }}     // every string, for translation
  theme="system"                                       // or "light" / "dark"
/>
```

**Hooks**, for your own UI (`@camelai/agent-runtime-react`):

```tsx
<AgentProvider endpoint="/api/agent">
  <MyChat />
</AgentProvider>

function MyChat() {
  const messages = useMessages();                  // user bubbles and assistant turns, as typed parts
  const send = useSend();
  const { status, isRunning, error, stop } = useAgentStatus();
  const { inputs, answer } = useInputs();
  const { hasOlder, loadOlder } = useLoadOlder();
  return messages.map(message => <Row key={message.id} message={message} />);
}
```

A message is `{ id, role: "user", text, parts, status: "sending" | "sent" | "failed" }` or
`{ id, role: "assistant", parts, streaming }`; parts are `text`, `reasoning`, `tool` (`name`, `args`
while they stream, `state`, `result`, `progress`, `input`) and `file`. A message that did not change
is the same object from one render to the next, and a sent message keeps its id when the agent's
copy arrives, so rows keyed by `id` never remount.

**shadcn**: copy the chat into your project, in your theme, and own the code:

```sh
npx shadcn add https://agents.camelai.dev/r/agent-chat.json
npx shadcn add https://agents.camelai.dev/r/agent-route.json   # the Next.js route
```

**AI SDK**: use `useChat` (and AI Elements) with the agent:

```tsx
import { useChat } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { AgentRuntimeChatTransport } from "@camelai/agent-runtime/ai-sdk";

const transport = useMemo(() => new AgentRuntimeChatTransport({ endpoint: "/api/agent" }), []);
const { messages, setMessages, sendMessage, addToolApprovalResponse, stop } = useChat({
  id: threadId,                        // the route's thread
  transport,
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
});
// The conversation so far, from the agent:
useEffect(() => { void transport.loadMessages({ chatId: threadId }).then(setMessages); }, [transport, threadId]);
```

The agent keeps the conversation, so only the new message is sent. Tool calls arrive as
`dynamic-tool` parts, approvals as tool approval requests, other questions as `data-agent-input`
parts (answer with `transport.answer(input, value, { chatId: threadId })`, then `resumeStream()`).

Without React, the store behind all of these is `createAgentChat` from
`@camelai/agent-runtime/chat`: `subscribe`, `getSnapshot`, `send`, `answer`, `stop`, `loadOlder`.

## Tools and generative UI

Give the agent tools in the route; draw their calls with your own components in the browser.

```ts
// route.ts
import { schema, tool } from "@camelai/agent-runtime";
agent: {
  tools: {
    get_weather: tool({
      description: "The weather in a city",
      input: schema.Object({ city: schema.String() }),
      execute: async ({ city }, { identity }) => weather.now(city),   // identity.subject is the user
    }),
  },
},
```

```tsx
function WeatherCard({ args, state, result }: ToolRenderProps) {
  if (state === "input_streaming") return <p>Looking up {String(args.city ?? "")}…</p>;
  return <Card data={result?.data} loading={state !== "done"} />;
}
<AgentChat endpoint="/api/agent" tools={{ get_weather: WeatherCard }} />
// or anywhere under the provider: useToolRenderer("get_weather", WeatherCard)
```

A renderer gets `args` (partial while the model writes them), `state` (`input_streaming`, `running`,
`input_required`, `done`, `error`), `result` (`text`, and `data` when it is JSON), `progress`, and,
for a call that waits on the user, its `input` and `answer(value)`.

Tools given in the route run in that server process, so it must keep running (`next dev`,
`next start`, a container, a Node or Bun server). On serverless hosting (Vercel functions,
Workers), serve the tools over HTTP with `serveTools` and name them in a definition:
`agent: { definition: "def_…" }` (see `clients/README.md`, "Serving tools to many users").
`serveTools` checks the runtime's signed identity on every call, and needs your tenant's id
(`GET /v1/me`), so another tenant's agents can never call your tools as your users:

```ts
// app/api/tools/route.ts
import { serveTools } from "@camelai/agent-runtime/server";
const handler = serveTools(tools, { runtime: "https://agents.camelai.dev", tenant: process.env.CAMELAI_TENANT! });
export { handler as GET, handler as POST };
```

With `nodeListener` (Express, node:http) behind a proxy that ends TLS, pass `trustProxy: true` only
if that proxy sets `X-Forwarded-Proto` and `X-Forwarded-Host` itself; they are ignored otherwise.

## Questions, approvals and files

When the agent asks (`ask_user`), a tool needs approval (`needsApproval`, or a definition's approval
policy), or a tool asks for a form or a URL step, the run waits, for days if need be. `<AgentChat>`
shows the question on the call that asked, with the choices, a form, or Approve and Deny; the
answer goes through your route as the user, and the run goes on. With hooks:
`useInputs().answer(input, value)`, where `value` is `true`/`false` for an approval, the chosen label
(or labels) for a question, or the fields for a form.

Files the agent hands over (`present_file`) show as images or downloads. Their signed links come with
the stream; for older ones the chat asks your route for a fresh link. The route signs links only for
files the agent presented, or that are in its own default `/workspace`: a volume you mounted into it
(shared data, say) is not downloadable by its users unless the agent hands a file over, or you set
`linkAnyMountedPath: true`.

## Conversations (threads)

A `thread` is your name for one of the user's conversations; each is its own agent, with its own
history:

```tsx
<AgentChat endpoint="/api/agent" thread={conversationId} />
```

The route receives it in `authorize(request, { thread })`. By default each user and thread is one
agent (`agentKeyFor(userId, thread)`).

**Agents several people share** (a team's assistant, a support conversation a customer and an agent
of yours both join): return the agent's key yourself, after checking the user may use it.

```ts
authorize: async (request, { thread }) => {
  const user = await getUser(request);
  if (!user) return null;
  // thread is the team's id here: only its members get its agent.
  if (thread && !(await isMember(user.id, thread))) return null;
  return { userId: user.id, name: user.name, agentKey: thread ? `team-${thread}` : undefined };
},
```

- The key is yours: 1 to 80 letters, digits, `_` and `-`, stable for as long as the conversation
  lives. Never build it from untrusted input without checking access first, as above.
- Each message is sent as its user (`from`), so the model knows who said what and the chat shows each
  sender's name; tools get the sender as `identity.actor`.
- The agent's `subject` (what its tools see as `identity.subject`) is set when it is made and never
  changes: for an agent you name, it is the key (`team-acme`), not whoever opened it first; return
  `subject` from `authorize` to choose it, and put what tools need (the team) in `agent.context`.
- Answers to the agent's questions are checked against who may answer: by default the person whose
  message started the turn.
- Everyone watching sees the same conversation, live.
- It is one conversation with one turn at a time: a message sent while the agent works waits for
  that turn (or joins it, with `whileRunning: "steer"`); anyone's Stop stops the turn for everyone;
  and a new message while the agent waits on a question supersedes the question (its call closes as
  not answered). Put per-user work in per-user agents.

## Theming and accessibility

`styles.css` defines the look with CSS variables on `.agent-chat` (or any ancestor):

```css
.agent-chat {
  --agent-accent: #4f46e5;        /* buttons, send */
  --agent-radius: 16px;
  --agent-font: "Inter", sans-serif;
  --agent-max-width: 880px;
}
```

Others: `--agent-bg`, `--agent-fg`, `--agent-muted`, `--agent-muted-fg`, `--agent-border`,
`--agent-user-bg`, `--agent-code-bg`, `--agent-danger`, `--agent-focus`, `--agent-font-size`. Dark mode
follows the system, a `.dark` (or `data-theme="dark"`) ancestor, or `theme="dark"`; use `theme="light"`
on a site without dark mode. With shadcn/ui, also import `@camelai/agent-runtime-react/shadcn.css`
to use your theme's tokens. Every rule is `:where(…)`, so your CSS wins without `!important`; class
names (`agent-chat__message`, …) are stable.

Accessibility: the conversation is a `log` that screen readers do not read token by token; a polite
status says when the assistant is responding and then reads its reply. Everything works with the
keyboard (Enter sends, Shift+Enter is a new line, Escape stops a run); questions are fieldsets with
radio and checkbox groups; focus is always visible; motion follows `prefers-reduced-motion`.

## Other frameworks

The store (`@camelai/agent-runtime/chat`) has no framework in it; the React bindings are a thin
layer over it, and so are those for Vue, Svelte and Solid (see their packages). React Native works
with the store and the hooks where `fetch` streams (Expo's `expo/fetch`), or with
`watch: { transport: "poll" }`.

## Troubleshooting

- **401 from the route**: `authorize` returned null: the user is not signed in, or the cookie did not
  reach the route (`credentials`).
- **"Could not reach the runtime … CORS"** in the browser: the runtime allows any origin only for
  browser tokens on its read routes; check the route's `browserToken.url` (or `CAMELAI_BASE_URL`).
- **Tool calls fail with "not connected"**: the process that serves the route's tools is not
  running (serverless); use `serveTools` and a definition.
- **Two server instances**: tools served from the route belong to one process at a time; run one
  instance, or serve tools over HTTP.
