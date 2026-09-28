/**
 * Vue bindings for an agent chat: `useAgentChat` in a component's setup gives reactive refs over the
 * chat with the user's agent (connected while the component lives) and its actions; `provideAgentChat`
 * and `useAgent` share one chat with descendants.
 *
 *   const { messages, status, send, stop } = useAgentChat({ endpoint: "/api/agent" });
 */
import { getCurrentScope, inject, onScopeDispose, provide, readonly, shallowRef, type InjectionKey, type Ref } from "vue";
import { createAgentChat, type AgentChat, type AgentChatOptions, type ChatSnapshot } from "@camelai/agent-runtime/chat";
export type * from "@camelai/agent-runtime/chat";
export { answerValue, createAgentChat } from "@camelai/agent-runtime/chat";

export interface UseAgentChat {
  chat: AgentChat;
  snapshot: Readonly<Ref<ChatSnapshot>>;
  messages: Readonly<Ref<ChatSnapshot["messages"]>>;
  status: Readonly<Ref<ChatSnapshot["status"]>>;
  inputs: Readonly<Ref<ChatSnapshot["inputs"]>>;
  error: Readonly<Ref<ChatSnapshot["error"]>>;
  hasOlder: Readonly<Ref<boolean>>;
  send: AgentChat["send"]; answer: AgentChat["answer"]; decline: AgentChat["decline"];
  stop: AgentChat["stop"]; retry: AgentChat["retry"]; loadOlder: AgentChat["loadOlder"]; fileUrl: AgentChat["fileUrl"];
}

/**
 * Refs over a chat: `options` makes one (connected until the component, or effect scope, ends), or pass
 * a chat you made. Each ref changes only when its part of the snapshot does.
 */
export function useAgentChat(options: Omit<AgentChatOptions, "autoConnect"> | AgentChat): UseAgentChat {
  const own = !("getSnapshot" in options);
  const chat = own ? createAgentChat({ ...options, autoConnect: false }) : options;
  const snapshot = shallowRef(chat.getSnapshot());
  const messages = shallowRef(snapshot.value.messages), status = shallowRef(snapshot.value.status), inputs = shallowRef(snapshot.value.inputs);
  const error = shallowRef(snapshot.value.error), hasOlder = shallowRef(snapshot.value.hasOlder);
  const unsubscribe = chat.subscribe(() => {
    const next = chat.getSnapshot();
    snapshot.value = next;
    // shallowRef only triggers on a new value: unchanged parts keep their identity, so nothing re-renders for them.
    messages.value = next.messages; status.value = next.status; inputs.value = next.inputs; error.value = next.error; hasOlder.value = next.hasOlder;
  });
  if (own) chat.connect();
  if (getCurrentScope()) onScopeDispose(() => { unsubscribe(); if (own) chat.destroy(); });
  return {
    chat, snapshot: readonly(snapshot) as Readonly<Ref<ChatSnapshot>>,
    messages: readonly(messages) as Readonly<Ref<ChatSnapshot["messages"]>>, status: readonly(status), inputs: readonly(inputs) as Readonly<Ref<ChatSnapshot["inputs"]>>,
    error: readonly(error) as Readonly<Ref<ChatSnapshot["error"]>>, hasOlder: readonly(hasOlder),
    send: chat.send, answer: chat.answer, decline: chat.decline, stop: chat.stop, retry: chat.retry, loadOlder: chat.loadOlder, fileUrl: chat.fileUrl,
  };
}

const KEY: InjectionKey<UseAgentChat> = Symbol("agent-chat");
/** Make a chat for this component and its descendants (`useAgent()` reads it). */
export function provideAgentChat(options: Omit<AgentChatOptions, "autoConnect"> | AgentChat): UseAgentChat {
  const value = useAgentChat(options);
  provide(KEY, value);
  return value;
}
/** The chat an ancestor provided. */
export function useAgent(): UseAgentChat {
  const value = inject(KEY, null);
  if (!value) throw new Error("useAgent needs an ancestor that called provideAgentChat");
  return value;
}
