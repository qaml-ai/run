import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useChat } from "@ai-sdk/react";
import { AgentRuntimeChatTransport } from "@camelai/agent-runtime/ai-sdk";

// Demo sign-in: a random user per browser (see server.ts).
const user = localStorage.demoUser ??= crypto.randomUUID();
const transport = new AgentRuntimeChatTransport({ endpoint: "/api/agent", headers: { "x-demo-user": user } });

function Chat() {
  // The chat's id is the route's thread: the agent keeps the conversation.
  const { messages, setMessages, sendMessage, status, stop } = useChat({ id: "main", transport });
  useEffect(() => { void transport.loadMessages({ chatId: "main" }).then(history => setMessages(history as never)); }, [setMessages]);
  const [text, setText] = useState("");
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: 16, font: "15px/1.5 system-ui, sans-serif" }}>
      {messages.map(message => (
        <div key={message.id} data-role={message.role} style={{ margin: "8px 0", whiteSpace: "pre-wrap" }}>
          <b>{message.role === "user" ? "You" : "Agent"}:</b>{" "}
          {message.parts.map((part, at) => part.type === "text" ? <span key={at}>{part.text}</span>
            : part.type === "dynamic-tool" ? <i key={at}> [{part.toolName}: {part.state}] </i> : null)}
        </div>
      ))}
      <form style={{ display: "flex", gap: 8 }} onSubmit={event => { event.preventDefault(); if (text.trim()) void sendMessage({ text }); setText(""); }}>
        <input value={text} onChange={event => setText(event.target.value)} aria-label="Message" placeholder="Message the agent…" style={{ flex: 1 }} />
        {status === "streaming" || status === "submitted" ? <button type="button" onClick={() => void stop()}>Stop</button> : <button>Send</button>}
      </form>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Chat />);
