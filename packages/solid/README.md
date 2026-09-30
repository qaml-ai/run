# @camelai/run-solid

Solid signals for a chat with an agent on camelRun, through your server's route
(`createAgentHandler` from `@camelai/run/server`; see the Frontend guide).

```tsx
import { For, Show, createSignal } from "solid-js";
import { useAgentChat } from "@camelai/run-solid";

function Chat() {
  const chat = useAgentChat({ endpoint: "/api/agent" });
  const [text, setText] = createSignal("");
  return (
    <>
      <For each={chat.messages()}>{message => <p>{message.role === "user" ? message.text : message.parts.map(part => part.type === "text" ? part.text : "").join("")}</p>}</For>
      <form onSubmit={event => { event.preventDefault(); void chat.send(text()); setText(""); }}>
        <input value={text()} onInput={event => setText(event.currentTarget.value)} />
      </form>
      <Show when={chat.status() === "streaming"}><button onClick={() => chat.stop()}>Stop</button></Show>
    </>
  );
}
```

`useAgentChat(options | chat)` returns accessors (`messages`, `status`, `inputs`, `error`, `hasOlder`,
`snapshot`) and actions (`send`, `answer`, `decline`, `stop`, `retry`, `loadOlder`, `fileUrl`); the chat
is connected until its owner is cleaned up.
