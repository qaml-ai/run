/**
 * Solid bindings for an agent chat: signals over the chat with the user's agent, connected while the
 * owner (a component) lives.
 *
 *   const chat = useAgentChat({ endpoint: "/api/agent" });
 *   <For each={chat.messages()}>{message => …}</For>
 */
import { createSignal, getOwner, onCleanup, onMount, type Accessor } from "solid-js";
import { createAgentChat, type AgentChat, type AgentChatOptions, type ChatSnapshot } from "@camelai/agent-runtime/chat";
export type * from "@camelai/agent-runtime/chat";
export { answerValue, createAgentChat } from "@camelai/agent-runtime/chat";

export interface UseAgentChat {
  chat: AgentChat;
  snapshot: Accessor<ChatSnapshot>;
  messages: Accessor<ChatSnapshot["messages"]>;
  status: Accessor<ChatSnapshot["status"]>;
  inputs: Accessor<ChatSnapshot["inputs"]>;
  error: Accessor<ChatSnapshot["error"]>;
  hasOlder: Accessor<boolean>;
  send: AgentChat["send"]; answer: AgentChat["answer"]; decline: AgentChat["decline"];
  stop: AgentChat["stop"]; retry: AgentChat["retry"]; loadOlder: AgentChat["loadOlder"]; fileUrl: AgentChat["fileUrl"];
}

/**
 * Signals over a chat: `options` makes one, or pass a chat you made. One it makes connects once mounted
 * (never while rendering on the server) and is destroyed when its owner is cleaned up.
 */
export function useAgentChat(options: Omit<AgentChatOptions, "autoConnect"> | AgentChat): UseAgentChat {
  const own = !("getSnapshot" in options);
  const chat = own ? createAgentChat({ ...options, autoConnect: false }) : options;
  // Signals compare with ===, so a part of the snapshot that kept its identity notifies nobody.
  const [snapshot, setSnapshot] = createSignal(chat.getSnapshot());
  const [messages, setMessages] = createSignal(snapshot().messages);
  const [status, setStatus] = createSignal(snapshot().status);
  const [inputs, setInputs] = createSignal(snapshot().inputs);
  const [error, setError] = createSignal(snapshot().error);
  const [hasOlder, setHasOlder] = createSignal(snapshot().hasOlder);
  const unsubscribe = chat.subscribe(() => {
    const next = chat.getSnapshot();
    setSnapshot(() => next); setMessages(() => next.messages); setStatus(() => next.status);
    setInputs(() => next.inputs); setError(() => next.error); setHasOlder(() => next.hasOlder);
  });
  if (own) {
    if (getOwner()) onMount(() => chat.connect());
    else if (typeof window !== "undefined") chat.connect();
  }
  if (getOwner()) onCleanup(() => { unsubscribe(); if (own) chat.destroy(); });
  return {
    chat, snapshot, messages, status, inputs, error, hasOlder,
    send: chat.send, answer: chat.answer, decline: chat.decline, stop: chat.stop, retry: chat.retry, loadOlder: chat.loadOlder, fileUrl: chat.fileUrl,
  };
}
