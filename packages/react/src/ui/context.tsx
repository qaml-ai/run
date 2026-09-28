import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import type { AssistantChatMessage, ChatInput, FilePart, ToolPart, UserChatMessage } from "@camelai/agent-runtime/chat";
import type { ToolRenderers } from "../index.tsx";

/** Every string the components show, for translation or tone. */
export interface Labels {
  placeholder: string;
  send: string;
  stop: string;
  composer: string;
  conversation: string;
  thinking: string;
  reasoning: string;
  responding: string;
  replied: string;
  needsInput: string;
  jumpToLatest: string;
  loadOlder: string;
  loadingOlder: string;
  emptyTitle: string;
  approve: string;
  deny: string;
  submit: string;
  skip: string;
  other: string;
  open: string;
  done: string;
  cancel: string;
  retry: string;
  reconnecting: string;
  sending: string;
  failed: string;
  stopped: string;
  copy: string;
  copied: string;
  download: string;
  toolRunning: (name: string) => string;
  toolDone: (name: string) => string;
  toolFailed: (name: string) => string;
  toolWaiting: (name: string) => string;
  arguments: string;
  result: string;
}

export const defaultLabels: Labels = {
  placeholder: "Message the agent…",
  send: "Send",
  stop: "Stop",
  composer: "Message",
  conversation: "Conversation",
  thinking: "Thinking…",
  reasoning: "Reasoning",
  responding: "The assistant is responding.",
  replied: "The assistant replied:",
  needsInput: "The assistant needs your input.",
  jumpToLatest: "Jump to latest",
  loadOlder: "Load earlier messages",
  loadingOlder: "Loading…",
  emptyTitle: "How can I help?",
  approve: "Approve",
  deny: "Deny",
  submit: "Submit",
  skip: "Skip",
  other: "Other",
  open: "Open",
  done: "Done",
  cancel: "Cancel",
  retry: "Retry",
  reconnecting: "Reconnecting…",
  sending: "Sending…",
  failed: "Not sent.",
  stopped: "Stopped.",
  copy: "Copy",
  copied: "Copied",
  download: "Download",
  toolRunning: name => `Running ${name}…`,
  toolDone: name => `Used ${name}`,
  toolFailed: name => `${name} failed`,
  toolWaiting: name => `${name} is waiting for you`,
  arguments: "Arguments",
  result: "Result",
};

/** Parts of the chat you can replace with your own components. */
export interface AgentChatComponents {
  /** Renders a message's markdown. Swap in react-markdown or Streamdown if you like. */
  Markdown: ComponentType<{ text: string; streaming: boolean; className?: string }>;
  UserMessage: ComponentType<{ message: UserChatMessage }>;
  AssistantMessage: ComponentType<{ message: AssistantChatMessage }>;
  /** A tool call with no renderer of its own. */
  ToolFallback: ComponentType<{ part: ToolPart }>;
  /** What the agent waits on: an approval, questions, a form or a link to open. */
  InputCard: ComponentType<{ input: ChatInput }>;
  FilePreview: ComponentType<{ part: FilePart }>;
  /** Shown before the first message. */
  EmptyState: ComponentType<{ suggestions: string[]; send(text: string): void }>;
}

export interface UIContextValue {
  labels: Labels;
  components: AgentChatComponents;
  tools?: ToolRenderers;
  allowImages: boolean;
  showReasoning: boolean;
}

export const UIContext = createContext<UIContextValue | null>(null);
/** Outside <AgentChat> (a Markdown of your own, say): the default labels, and no images. */
const OUTSIDE = { labels: defaultLabels, allowImages: false, showReasoning: true } as UIContextValue;
export function useUI(): UIContextValue {
  return useContext(UIContext) ?? OUTSIDE;
}

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");
export type Children = { children?: ReactNode };
