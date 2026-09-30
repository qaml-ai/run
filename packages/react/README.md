# @camelai/run-react

React hooks and components for a streaming chat with an agent on the
[camelRun](https://run.camelai.com). Your server has one route
(`createAgentHandler` from `@camelai/run/server`); these talk to it.

```sh
npm install @camelai/run @camelai/run-react
```

## Prebuilt

```tsx
import { AgentChat } from "@camelai/run-react/ui";
import "@camelai/run-react/styles.css";

<AgentChat endpoint="/api/agent" suggestions={["Where is my order?"]} tools={{ get_weather: WeatherCard }} />
```

Messages stream in as markdown; tool calls show as cards or your components; the agent's
questions and approvals are answered in place; files it hands over are previews or downloads; the
composer stops a run. Props: `endpoint` or `chat`, `thread`, `tools`, `components` (Markdown,
UserMessage, AssistantMessage, ToolFallback, InputCard, FilePreview, EmptyState), `labels`,
`placeholder`, `suggestions`, `theme`, `allowImages`, `showReasoning`, `whileRunning`, `data`,
`header`, `className`, `style`. Theme it with CSS variables (`--agent-accent`, `--agent-radius`, …),
or import `shadcn.css` too to follow a shadcn/ui theme.

## Hooks

```tsx
import { AgentProvider, useMessages, useSend, useAgentStatus, useInputs } from "@camelai/run-react";

<AgentProvider endpoint="/api/agent" thread={threadId}>
  <MyChat />
</AgentProvider>
```

| Hook | Returns |
| --- | --- |
| `useMessages()` | the messages, as typed parts (`text`, `reasoning`, `tool`, `file`) |
| `useSend()` | `send(text, { data? })`: shows the message at once, keyed by the id it keeps |
| `useAgentStatus()` | `{ status, isRunning, error, connected, stop, retry }` |
| `useInputs()` | `{ inputs, answer(input, value), decline(input) }` |
| `useLoadOlder()` | `{ hasOlder, loading, loadOlder }` |
| `useToolRenderer(name, Component)` | draws that tool's calls with your component |
| `useAgentSelector(select)` | any part of the snapshot, re-rendering only when it changes |
| `useAgent()` / `useAgentChat(options)` | the chat itself (`@camelai/run/chat`) |

Each hook re-renders only when what it returns changes, and unchanged messages keep their objects,
so a streamed token re-renders one message.

See the [Frontend guide](../../docs/frontend.md) for the route, security, tools, questions,
threads and theming.
