"use client";

/**
 * A prebuilt chat with the user's agent: messages that stream in as markdown, tool cards (or your own
 * components per tool), the agent's questions and approvals, files it hands over, a composer with
 * stop, and scrolling that follows the reply. Themed with CSS variables; import the stylesheet once:
 *
 *   import { AgentChat } from "@camelai/run-react/ui";
 *   import "@camelai/run-react/styles.css";
 *
 *   <AgentChat endpoint="/api/agent" suggestions={["Where is my order?"]} />
 */
import { useMemo, type CSSProperties, type ReactNode } from "react";
import type { AgentChat as Chat, ChatInput } from "@camelai/run/chat";
import { AgentProvider, useAgent, useAgentSelector, useAgentStatus, type ToolRenderers, type UseAgentChatOptions } from "../index.tsx";
import { Composer, type ComposerHandle, type ComposerProps } from "./composer.tsx";
import { cx, defaultLabels, UIContext, useUI, type AgentChatComponents, type Labels, type UIContextValue } from "./context.tsx";
import { FilePreview } from "./file.tsx";
import { Markdown } from "./markdown.tsx";
import { AssistantMessage, EmptyState, MessageList, UserMessage } from "./messages.tsx";
import { InputCard, ToolCard, ToolView } from "./tool.tsx";

export { Composer, FilePreview, InputCard, Markdown, MessageList, ToolCard, ToolView, UserMessage, AssistantMessage, EmptyState, defaultLabels };
export type { AgentChatComponents, ComposerHandle, ComposerProps, Labels };

export interface AgentChatProps extends Partial<UseAgentChatOptions> {
  /** A chat you made (`useAgentChat`); else `endpoint`; else the nearest <AgentProvider>'s. */
  chat?: Chat;
  /** Your own components for tool calls, by tool name (generative UI). */
  tools?: ToolRenderers;
  /** Replace parts of the chat: Markdown, UserMessage, AssistantMessage, ToolFallback, InputCard, FilePreview, EmptyState. */
  components?: Partial<AgentChatComponents>;
  labels?: Partial<Labels>;
  placeholder?: string;
  /** Prompts offered before the first message. */
  suggestions?: string[];
  /** "light", "dark", or "system" (default: the page's `prefers-color-scheme`, or a `.dark` ancestor). */
  theme?: "light" | "dark" | "system";
  /** Show images the agent links in its markdown (off by default: loading them tells their server about the reader). */
  allowImages?: boolean;
  /** Show the model's reasoning, collapsed (default true). */
  showReasoning?: boolean;
  autoFocus?: boolean;
  /** JSON sent with each message, for your handler's `onSend`. */
  data?: ComposerProps["data"];
  /** Content above the messages (a title bar). */
  header?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** The whole chat. Inside an <AgentProvider> it uses that chat; with `endpoint` it makes its own. */
export function AgentChat({ chat, endpoint, tools, ...props }: AgentChatProps) {
  const { thread, headers, credentials, whileRunning, watch, onEvent, onError, fetch, ...rest } = props;
  if (chat || endpoint) {
    const options = { thread, headers, credentials, whileRunning, watch, onEvent, onError, fetch };
    const defined = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    return <AgentProvider chat={chat} endpoint={endpoint} {...defined}><AgentChatRoot tools={tools} whileRunning={whileRunning} {...rest} /></AgentProvider>;
  }
  return <AgentChatRoot tools={tools} whileRunning={whileRunning} {...rest} />;
}

const DEFAULT_COMPONENTS: AgentChatComponents = { Markdown, UserMessage, AssistantMessage, ToolFallback: ToolCard, InputCard, FilePreview, EmptyState };

/** The chat's layout, for the chat of the nearest <AgentProvider>. */
export function AgentChatRoot({
  tools, components, labels, placeholder, suggestions, theme = "system", allowImages = false, showReasoning = true,
  autoFocus, data, header, className, style, whileRunning,
}: Omit<AgentChatProps, "chat" | "endpoint">) {
  useAgent();
  const value = useMemo<UIContextValue>(() => ({
    labels: { ...defaultLabels, ...labels }, components: { ...DEFAULT_COMPONENTS, ...components }, tools, allowImages, showReasoning,
  }), [labels, components, tools, allowImages, showReasoning]);
  return (
    <UIContext.Provider value={value}>
      <div className={cx("agent-chat", className)} style={style} data-theme={theme === "system" ? undefined : theme}>
        {header}
        <MessageList suggestions={suggestions} />
        <LooseInputs />
        <ErrorBanner />
        <Composer placeholder={placeholder} autoFocus={autoFocus} data={data} whileRunning={whileRunning} />
      </div>
    </UIContext.Provider>
  );
}

/** Inputs whose call is not on screen (its turn is on an older page, or a tool asked outside a call). */
function LooseInputs() {
  const { components } = useUI();
  const loose = useAgentSelector(snapshot => {
    const shown = new Set<string>();
    for (const message of snapshot.messages) if (message.role === "assistant") for (const part of message.parts) if (part.type === "tool" && part.input) shown.add(part.input.id);
    const rest = snapshot.inputs.filter(input => !shown.has(input.id));
    return rest.length ? rest : EMPTY;
  }, { equal: (a, b) => a.length === b.length && a.every((input, at) => input === b[at]) });
  if (!loose.length) return null;
  return <div className="agent-chat__loose-inputs">{loose.map(input => <components.InputCard key={input.id} input={input} />)}</div>;
}
const EMPTY: ChatInput[] = [];

/** The chat's own trouble (a send's shows on its message): it could not start, or the stream is reconnecting. */
function ErrorBanner() {
  const { labels } = useUI();
  const { error, status, connected } = useAgentStatus();
  if (status === "error" && error) return <div className="agent-chat__error" role="alert">{error.message || labels.failed}</div>;
  if (error?.code === "stream_error" && !connected) return <div className="agent-chat__error agent-chat__error--soft" role="status">{labels.reconnecting}</div>;
  return null;
}
