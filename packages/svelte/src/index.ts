/**
 * Svelte bindings for an agent chat: stores over the chat with the user's agent, connected while
 * anything subscribes. They follow the store contract, so `$messages` works in Svelte 4 and 5.
 *
 *   const chat = agentChat({ endpoint: "/api/agent" });
 *   const { messages, status } = chat;   // then $messages, $status in markup
 *   chat.send("Hello");
 */
import { createAgentChat, type AgentChat, type AgentChatOptions, type ChatSnapshot } from "@camelai/agent-runtime/chat";
export type * from "@camelai/agent-runtime/chat";
export { answerValue, createAgentChat } from "@camelai/agent-runtime/chat";

/** A Svelte store (the store contract), readable only. */
export interface Readable<T> { subscribe(run: (value: T) => void): () => void }

export interface AgentChatStores {
  chat: AgentChat;
  snapshot: Readable<ChatSnapshot>;
  messages: Readable<ChatSnapshot["messages"]>;
  status: Readable<ChatSnapshot["status"]>;
  inputs: Readable<ChatSnapshot["inputs"]>;
  error: Readable<ChatSnapshot["error"]>;
  hasOlder: Readable<boolean>;
  send: AgentChat["send"]; answer: AgentChat["answer"]; decline: AgentChat["decline"];
  stop: AgentChat["stop"]; retry: AgentChat["retry"]; loadOlder: AgentChat["loadOlder"]; fileUrl: AgentChat["fileUrl"];
}

/**
 * Stores over a chat: `options` makes one, connected from the first subscriber to the last (a chat you
 * pass stays as you left it). Each store notifies only when its part of the snapshot changes.
 */
export function agentChat(options: Omit<AgentChatOptions, "autoConnect"> | AgentChat): AgentChatStores {
  const own = !("getSnapshot" in options);
  const chat = own ? createAgentChat({ ...options, autoConnect: false }) : options;
  let subscribers = 0;
  const select = <T>(pick: (snapshot: ChatSnapshot) => T): Readable<T> => ({
    subscribe(run) {
      if (subscribers++ === 0 && own) chat.connect();
      let last = pick(chat.getSnapshot());
      run(last);
      const off = chat.subscribe(() => {
        const next = pick(chat.getSnapshot());
        if (!Object.is(next, last)) { last = next; run(next); }
      });
      return () => { off(); if (--subscribers === 0 && own) chat.disconnect(); };
    },
  });
  return {
    chat,
    snapshot: select(snapshot => snapshot), messages: select(snapshot => snapshot.messages), status: select(snapshot => snapshot.status),
    inputs: select(snapshot => snapshot.inputs), error: select(snapshot => snapshot.error), hasOlder: select(snapshot => snapshot.hasOlder),
    send: chat.send, answer: chat.answer, decline: chat.decline, stop: chat.stop, retry: chat.retry, loadOlder: chat.loadOlder, fileUrl: chat.fileUrl,
  };
}
