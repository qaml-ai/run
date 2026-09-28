import { For, Show, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { useAgentChat } from "@camelai/agent-runtime-solid";

// Demo sign-in: a random user per browser (see server.ts).
const user = (localStorage.demoUser ??= crypto.randomUUID());

function Chat() {
  const chat = useAgentChat({ endpoint: "/api/agent", headers: { "x-demo-user": user } });
  const [text, setText] = createSignal("");
  const busy = () => chat.status() === "streaming" || chat.status() === "submitted";
  return (
    <main style={{ "max-width": "640px", margin: "0 auto", padding: "16px" }}>
      <For each={chat.messages()}>{message => (
        <div data-role={message.role} style={{ margin: "8px 0", "white-space": "pre-wrap" }}>
          <b>{message.role === "user" ? "You" : "Agent"}:</b>{" "}
          {message.role === "user" ? message.text : <For each={message.parts}>{part =>
            part.type === "text" ? part.text : part.type === "tool" ? <i> [{part.name}: {part.state}] </i> : null}</For>}
        </div>
      )}</For>
      <form style={{ display: "flex", gap: "8px" }} onSubmit={event => { event.preventDefault(); if (text().trim()) void chat.send(text()); setText(""); }}>
        <input value={text()} onInput={event => setText(event.currentTarget.value)} aria-label="Message" placeholder="Message the agent…" style={{ flex: 1 }} />
        <Show when={busy()} fallback={<button>Send</button>}><button type="button" onClick={() => chat.stop()}>Stop</button></Show>
      </form>
    </main>
  );
}

render(() => <Chat />, document.getElementById("app")!);
