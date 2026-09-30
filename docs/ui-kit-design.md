# Frontend and server kits: design

Status: built on `feat/ui-kit` (from `feat/dx-sdk`); the developer guide is `docs/frontend.md`. Goal: a developer gets a
working, streaming agent chat in their app in minutes, in any common stack, on
APIs we can keep for years.

We follow the shape developers already know: a server route that holds the
secret (Clerk, Stripe, Liveblocks auth endpoints), a headless store with thin
framework bindings (Liveblocks, TanStack), hooks named like the AI SDK's
(`useChat`-style), prebuilt components that are themeable and replaceable
piece by piece (Stripe Elements, Liveblocks `react-ui`, CopilotKit), and a
shadcn registry for people who want the source (assistant-ui).

## 1. Packages

One release train: every package below has the same version, is published from
the same tag, and depends on the exact same version of the core.

| Package | Import | What |
| --- | --- | --- |
| `@camelai/run` (exists) | `/server` | + `createAgentHandler`: the developer's server route (fetch-standard) |
| | `/chat` | **new**: the headless store `createAgentChat`, message parts, `answerValue`. No dependencies, no Node APIs |
| | `/markdown` | **new**: the streaming-safe markdown parser (an AST any framework renders) |
| | `/watch` (exists) | the browser watcher `/chat` is built on |
| | `/ai-sdk` | **new**: `AgentRuntimeChatTransport` for the AI SDK's `useChat` (structural types; no `ai` dependency) |
| `@camelai/run-react` | `.` | `AgentProvider`, `useAgent`, `useMessages`, `useSend`, `useInputs`, `useAgentStatus`, `useToolRenderer` |
| | `/ui` | `<AgentChat/>` and its parts (`Messages`, `Composer`, `ToolCard`, `QuestionCard`, `FilePreview`, `Markdown`) |
| | `/styles.css`, `/shadcn.css` | default theme; a theme that maps onto shadcn tokens |
| `@camelai/run-vue`, `-svelte`, `-solid` | `.` | bindings over `/chat` (later) |
| `@camelai/create-run-app` | `npm create @camelai/run-app` | Next.js starter |
| shadcn registry | `npx shadcn add https://run.camelai.com/r/agent-chat.json` | Tailwind + shadcn-token versions of the `/ui` components, over the React hooks |

Why subpaths of the core rather than more packages: a server developer already
installs `@camelai/run` for tools, so the route handler is one import
away; the headless store sits next to the watcher it wraps and versions with the
event protocol it folds. Framework code is its own package so the core stays
dependency-free. Sources: `clients/handler.ts`, `clients/chat.ts`,
`clients/ai-sdk.ts`, `packages/react/`, `packages/create-run-app/`,
`packages/registry/`.

## 2. Server: `createAgentHandler`

```ts
// app/api/agent/route.ts (Next.js App Router)
import { createAgentHandler } from "@camelai/run/server";

const handler = createAgentHandler({
  apiKey: process.env.CAMELAI_API_KEY,               // never leaves the server
  // Your own session check. null → 401. The browser never names an agent id.
  authorize: async (request, { thread }) => {
    const user = await auth(request);                  // Clerk, NextAuth, Lucia, your cookie…
    return user ? { userId: user.id, name: user.name } : null;  // agentKey defaults to agentKeyFor(userId, thread)
  },
  agent: { instructions: "You help with orders.", model: "anthropic/claude-sonnet-5", tools },  // or (auth) => config, or { definition }
});
export const POST = handler;
```

Hono: `app.post("/api/agent", c => handler(c.req.raw))`. Workers/Bun/Deno:
`export default { fetch: handler }`. Express/Node: `app.post("/api/agent",
nodeListener(handler))` (`nodeListener` from `/node`, exists).

One POST endpoint, JSON body `{ action, thread?, ... }`, so it mounts in every
framework without a catch-all route:

| action | body | runtime call (tenant key) | answer |
| --- | --- | --- | --- |
| `token` | – | upsert (cached) + `POST /v1/agents/:id/browser-tokens {subject, redact:["usage.cost"], ttlSeconds}` | `{ token, expiresAt, agentId, url }` |
| `send` | `{ text, clientId, whileRunning?, data? }` | `POST /v1/agents/:id/prompt {text, requestId: clientId, from, metadata:{clientId,…}, whileRunning}` | `{ requestId }` |
| `answer` | `{ inputId, action, content? }` | `POST /v1/agents/:id/inputs/:inputId {…, from}` | `{ input, request }` |
| `stop` | – | `POST /v1/agents/:id/abort` | `{ ok }` |
| `link` | `{ path }` | `POST /clients/:id/links {path}` (the agent's own token: only its mounts) | `{ url, expiresAt }` |

- **Agents.** `authorize` returns `{ userId, name?, agentKey? }`. The agent is
  `agentKey` or `agentKeyFor(userId, thread)` (a hash of both, so no user's
  thread can collide with another's), upserted once per process with
  `subject: userId` and the handler's `agent` config, then cached. A browser
  reaches only agents its `authorize` returned; there is no agent id in any
  request.
- **Writes.** `from = { id: userId, name }` on every send and answer, never
  from the client; the runtime checks answers against the input's audience.
  `requestId = clientId`, so a retried send is the same run (idempotent);
  `clientId` is validated (`[A-Za-z0-9_-]{8,80}`).
- **Hooks.** `onSend({ auth, text, data, request })` may return `{ text?,
  metadata? }` or throw a `Response` (quotas, moderation); `data` is the client's
  free JSON and reaches the runtime only through this hook. `browserToken: { ttlSeconds, events, redact }`.
- **CSRF.** Requests must be `application/json` (no simple-form posts), and a
  `Sec-Fetch-Site: cross-site` request is refused unless its `Origin` is in
  `allowedOrigins`.
- **Tools.** `agent.tools` are attached from this process (fine for `next
  dev`, Node, Hono on Node, one instance). Serverless or several instances:
  `serveTools` + a definition (`agent: { definition }`); the docs say which.
- Errors are `{ error: { code, message } }` with the runtime's stable codes.

## 3. Headless core: `createAgentChat`

```ts
import { createAgentChat } from "@camelai/run/chat";

const chat = createAgentChat({ endpoint: "/api/agent", thread: "support" });
const off = chat.subscribe(() => render(chat.getSnapshot()));  // useSyncExternalStore-shaped
await chat.send("Where is my order?");                          // optimistic, keyed by clientId
await chat.answer(input, "Yes");                                // approval: true/false; question: label(s); form: fields
await chat.stop(); await chat.loadOlder(); chat.destroy();
```

Snapshot (immutable; unchanged messages and parts keep their identity):

```ts
interface ChatSnapshot {
  status: "connecting" | "ready" | "submitted" | "streaming" | "input_required" | "error";
  messages: ChatMessage[];          // user bubbles and assistant turns
  inputs: PendingInput[];           // everything the agent waits on
  error: ChatError | null;          // { code, message }
  hasOlder: boolean; connected: boolean;
}
type ChatMessage =
  | { id; role: "user"; parts: (TextPart | FilePart)[]; from?: Sender; metadata?; createdAt; status: "sending" | "sent" | "failed" }
  | { id; role: "assistant"; parts: AssistantPart[]; createdAt; streaming: boolean; stopReason?: "stop" | "aborted" | "error"; error?: string };
type AssistantPart =
  | { type: "text"; id; text; streaming: boolean }
  | { type: "reasoning"; id; text; streaming: boolean }
  | { type: "tool"; id /* toolCallId */; name; args; state: "input_streaming" | "running" | "input_required" | "done" | "error";
      result?: { text: string; data?: unknown }; progress?: unknown; input?: PendingInput }
  | { type: "file"; id; path; name; contentType; size; caption?; url?: string };
```

Projection rules (from chiridion's pi-render and its flashing fixes):
- Everything the agent did between two user messages (assistant messages and
  their tool results) is one assistant message; each tool result folds into
  its call's part. `present_file` calls become `file` parts, with the signed URL
  from `file_presented`, else fetched through `link` on demand.
- A user message takes its `requestId` (the client id) as its id, so the
  optimistic bubble's row is the echoed message's row: no remount.
- A running turn continues the last one only if that one called tools;
  otherwise it is a new turn at the index its first message will take, and
  never shows above a send still on its way.
- Memoized by source objects: a message whose Pi messages did not change is the
  same object; parts too. Only the streaming turn is rebuilt per delta.
- A tool result that is an input placeholder (`details.inputRequired`) leaves
  its call `input_required` with the input attached.

## 4. React

```tsx
<AgentProvider endpoint="/api/agent" thread={threadId} tools={{ get_weather: WeatherCard }}>
  <AgentChat />                                          // or build your own:
</AgentProvider>

const { messages } = useMessages();   const send = useSend();
const { status, error, stop } = useAgentStatus();   const { inputs, answer } = useInputs();
const chat = useAgent();              // the store; useAgent({ endpoint }) without a provider
useToolRenderer("get_weather", ({ args, result, state }) => <Weather … />);
```

All hooks are `useSyncExternalStore` selectors over the store, so a streaming
token re-renders the streaming message only.

## 5. Prebuilt components

```tsx
import { AgentChat } from "@camelai/run-react/ui";
import "@camelai/run-react/styles.css";

<AgentChat
  endpoint="/api/agent"
  placeholder="Ask about your orders"
  suggestions={["Where is my order?"]}
  tools={{ get_weather: ({ args, result, state }) => <Weather {...args} data={result?.data} loading={state !== "done"} /> }}
  components={{ Markdown, UserMessage, EmptyState, ToolFallback }}   // slots
  className="h-full"
/>
```

- Message list with sticky-bottom scroll (follows the stream only while at the
  bottom; a "jump to latest" button otherwise; keeps position on `loadOlder`).
- Streaming markdown: a small safe renderer (no raw HTML; links
  `rel="noopener noreferrer"`, `http(s)`/`mailto` only), tolerant of unclosed
  fences and emphasis mid-stream; swap it via `components.Markdown`
  (react-markdown, Streamdown).
- Tool cards (collapsible: name, arguments while streaming, result, error,
  progress), question cards (approval, choices, free text, form, URL step),
  file previews (images inline, others as download links through `link`), stop
  button, error banner with retry.
- **Theming**: CSS variables (`--agent-bg`, `--agent-fg`, `--agent-muted`,
  `--agent-border`, `--agent-accent`, `--agent-accent-fg`, `--agent-radius`,
  `--agent-font`, `--agent-mono`…) under `.agent-chat`; dark mode by
  `prefers-color-scheme`, or forced with `data-theme="dark|light"` on it or an
  ancestor (`.dark` too). `shadcn.css` maps them onto shadcn's tokens. Class
  names are stable (`agent-chat__message`) and every part takes `className`;
  `unstyled` drops ours.
- **Accessibility**: the list is `role="log"`; streaming text is not announced
  token by token: a visually hidden `aria-live="polite"` region says "Assistant
  is responding", then the finished reply. Composer: labelled textarea, Enter
  sends, Shift+Enter newline, Escape stops a run. Question cards are
  `fieldset`/`legend` with radio or checkbox groups; they announce, never steal
  focus. Buttons have names; focus rings visible; `prefers-reduced-motion`
  respected; WCAG AA contrast in both themes: a test computes every text color against its backgrounds from styles.css (axe in jsdom cannot, having no layout, so its color-contrast rule is off there).

## 6. Generative UI (per-tool renderers)

A renderer gets `{ args, result, state, progress, input, answer }` and returns
UI. `args` is partial JSON while `state === "input_streaming"`, so a card can
fill in as the model writes. Registered by prop (`tools`), provider, or
`useToolRenderer`; unknown tools use `ToolFallback`. Renderers for inputs
(`approval`, `question`) receive `answer(value)`, which makes approval buttons
inside a custom card trivial.

## 7. Bundle size

Budgets (min+gzip, checked by tests with esbuild): `/chat` + `/watch` ≤ 9 KB
(7.5 KB), React hooks ≤ 2 KB (1.5 KB), `/ui` ≤ 14 KB including markdown (9.3 KB),
CSS ≤ 4 KB. No runtime
dependencies besides React (peer). Everything is ESM with `sideEffects` limited
to the CSS files, so unused components tree-shake.

## 8. Versioning

The event protocol (ready frame `version`) and these packages move together:
one version for all, one tag (`sdk-vX.Y.Z`), exact inter-package dependencies.
Additive protocol changes (new event types) are ignored by older stores, which
render unknown parts as nothing. While 0.x, a breaking change bumps the minor
and is listed in the release notes; from 1.0, semver with deprecations kept one
minor. Public types are exported and documented; internals are not.

## 9. Testing

- Core and handler: `node:test` like the rest of the repo. Handler tests run
  against the real runtime process with the scripted model (`tests/runtime-server.ts`):
  ownership (a user cannot reach another's agent), idempotent sends, `from`
  enforcement, CSRF refusals, answers, stop, links.
- Store: scripted watcher event sequences (send before/after run start, steer,
  tool calls, inputs, retraction, snapshot) asserting the projection and
  object identity (no-flash invariants).
- React: vitest + jsdom + Testing Library: hooks, the components, mount counts
  across a send (no remounts), keyboard use, axe checks.
- End to end: the starter against a local runtime with a real model (under $3),
  driven in a browser.

## 10. Rollout

1. Server handler. 2. Headless store. 3. React hooks. 4. `<AgentChat/>`.
5. shadcn registry. 6. AI SDK transport. 7. `create-run-app` (Next.js).
8. Vue, Svelte, Solid; React Native note (the store is fetch-only; RN needs a
streaming `fetch`, e.g. `expo/fetch`, or `transport: "poll"`).

## Asks of the runtime (not blocking)

- Serve the registry JSON at `https://run.camelai.com/r/*.json` (the repo is
  private, so GitHub raw URLs do not work for users).
- A tenant route for a file link by agent and path (`POST
  /v1/agents/:id/links`), so `link` needs no agent token; until then the
  handler uses the token the upsert returns.
