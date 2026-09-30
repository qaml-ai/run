"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
  AgentProvider, useAgent, useAgentSelector, useAgentStatus, useLoadOlder, useMessages, useSend,
  type AssistantChatMessage, type ChatMessage, type ToolRenderers, type UserChatMessage,
} from "@camelai/run-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AgentMarkdown } from "./agent-markdown";
import { AgentFile, AgentInputCard, AgentTool } from "./agent-parts";

export interface AgentChatProps {
  /** Your agent handler's route (createAgentHandler from @camelai/run/server). */
  endpoint: string;
  /** Which of the user's conversations. */
  thread?: string;
  /** Components for tool calls, by tool name (generative UI). */
  tools?: ToolRenderers;
  suggestions?: string[];
  placeholder?: string;
  className?: string;
}

/** A chat with the user's agent, in your shadcn theme. The code is yours: change anything. */
export function AgentChat({ endpoint, thread, tools, ...props }: AgentChatProps) {
  return (
    <AgentProvider endpoint={endpoint} thread={thread}>
      <AgentChatView tools={tools} {...props} />
    </AgentProvider>
  );
}

export function AgentChatView({ tools, suggestions = [], placeholder = "Message the agent…", className }: Omit<AgentChatProps, "endpoint" | "thread">) {
  const messages = useMessages();
  const { status, error } = useAgentStatus();
  const send = useSend();
  const { scroller, content, atBottom, toBottom } = useStickToBottom(messages);
  const { hasOlder, loading, loadOlder } = useLoadOlder();
  const waiting = status === "submitted" && !messages.some(message => message.role === "assistant" && message.streaming);
  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background text-foreground", className)}>
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} role="log" aria-label="Conversation" aria-live="off" tabIndex={0} className="h-full overflow-y-auto">
          <div ref={content} className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
            {hasOlder && <Button variant="outline" size="sm" className="self-center rounded-full" disabled={loading} onClick={() => void loadOlder()}>{loading ? "Loading…" : "Load earlier messages"}</Button>}
            {!messages.length && status !== "connecting" && (
              <div className="flex flex-col items-center gap-4 py-12 text-center">
                <p className="text-lg font-semibold">How can I help?</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {suggestions.map(suggestion => <Button key={suggestion} variant="outline" size="sm" className="rounded-full" onClick={() => void send(suggestion)}>{suggestion}</Button>)}
                </div>
              </div>
            )}
            {messages.map(message => <Row key={message.id} message={message} tools={tools} />)}
            {waiting && <p className="animate-pulse text-sm text-muted-foreground" aria-hidden="true">Thinking…</p>}
          </div>
        </div>
        {!atBottom && <Button variant="outline" size="sm" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow" onClick={() => toBottom(true)}>Jump to latest</Button>}
      </div>
      <Announcer />
      <Inputs />
      {status === "error" && error && <p role="alert" className="mx-auto mb-2 w-full max-w-3xl rounded-md border border-destructive px-3 py-2 text-sm text-destructive">{error.message}</p>}
      <Composer placeholder={placeholder} />
    </div>
  );
}

const Row = memo(function Row({ message, tools }: { message: ChatMessage; tools?: ToolRenderers }) {
  return message.role === "user" ? <UserBubble message={message} /> : <AssistantTurn message={message} tools={tools} />;
});

const UserBubble = memo(function UserBubble({ message }: { message: UserChatMessage }) {
  const chat = useAgent();
  return (
    <div className="flex flex-col items-end gap-1">
      {message.from?.name && <span className="text-xs text-muted-foreground">{message.from.name}</span>}
      <div className={cn("max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-secondary px-4 py-2 text-sm text-secondary-foreground", message.status === "sending" && "opacity-70")}>{message.text}</div>
      {message.status === "failed" && (
        <p role="alert" className="text-xs text-destructive">
          {message.error?.message ?? "Not sent."}{" "}
          <button type="button" className="underline" onClick={() => void chat.retry(message.id)}>Retry</button>
        </p>
      )}
    </div>
  );
});

const AssistantTurn = memo(function AssistantTurn({ message, tools }: { message: AssistantChatMessage; tools?: ToolRenderers }) {
  const last = message.parts.at(-1);
  return (
    <div className="flex flex-col gap-2">
      {message.parts.map(part => {
        switch (part.type) {
          case "text": return <AgentMarkdown key={part.id} text={part.text} streaming={message.streaming && part === last} />;
          case "reasoning": return part.redacted ? null : (
            <details key={part.id} className="rounded-md border text-sm text-muted-foreground">
              <summary className="cursor-pointer px-3 py-2">{part.streaming ? "Thinking…" : "Reasoning"}</summary>
              <p className="whitespace-pre-wrap px-3 pb-3">{part.text}</p>
            </details>
          );
          case "tool": return <AgentTool key={part.id} part={part} tools={tools} />;
          case "file": return <AgentFile key={part.id} part={part} />;
          default: return null;
        }
      })}
      {message.stopReason === "aborted" && <p className="text-xs text-muted-foreground">Stopped.</p>}
      {message.stopReason === "error" && <p className="text-xs text-destructive">{message.error ?? "The reply failed."}</p>}
    </div>
  );
});

/** Inputs whose call is not on screen. */
function Inputs() {
  const loose = useAgentSelector(snapshot => {
    const shown = new Set(snapshot.messages.flatMap(message => message.role === "assistant" ? message.parts.flatMap(part => part.type === "tool" && part.input ? [part.input.id] : []) : []));
    return snapshot.inputs.filter(input => !shown.has(input.id));
  }, { equal: (a, b) => a.length === b.length && a.every((input, at) => input === b[at]) });
  if (!loose.length) return null;
  return <div className="mx-auto mb-2 w-full max-w-3xl space-y-2 px-4">{loose.map(input => <AgentInputCard key={input.id} input={input} />)}</div>;
}

function Composer({ placeholder }: { placeholder: string }) {
  const send = useSend();
  const { isRunning, stop } = useAgentStatus();
  const [text, setText] = useState("");
  const submit = () => {
    const message = text.trim();
    if (!message) { if (isRunning) void stop(); return; }
    setText("");
    void send(message);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
    else if (event.key === "Escape" && isRunning) { event.preventDefault(); void stop(); }
  };
  const stopping = isRunning && !text.trim();
  return (
    <form className="mx-auto mb-4 flex w-[calc(100%-2rem)] max-w-3xl items-end gap-2 rounded-2xl border bg-background p-2 pl-4 focus-within:ring-1 focus-within:ring-ring" onSubmit={event => { event.preventDefault(); submit(); }}>
      <textarea
        rows={1} value={text} placeholder={placeholder} aria-label="Message"
        className="max-h-48 min-h-9 flex-1 resize-none bg-transparent py-2 text-sm outline-none [field-sizing:content] placeholder:text-muted-foreground"
        onChange={event => setText(event.currentTarget.value)} onKeyDown={onKeyDown} />
      <Button type="submit" size="icon" className="size-9 shrink-0 rounded-full" disabled={!stopping && !text.trim()} aria-label={stopping ? "Stop" : "Send"}>
        {stopping ? <span className="size-3 rounded-sm bg-current" /> : <span aria-hidden="true">↑</span>}
      </Button>
    </form>
  );
}

/** Says "responding", then the finished reply, to screen readers (the log itself is not read token by token). */
function Announcer() {
  const status = useAgentSelector(snapshot => snapshot.status);
  const reply = useAgentSelector(snapshot => {
    const last = snapshot.messages.at(-1);
    return last?.role === "assistant" && !last.streaming ? last.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").slice(0, 1000) : "";
  });
  const [text, setText] = useState("");
  const previous = useRef(status);
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (status === "streaming" && was !== "streaming") setText("The assistant is responding.");
    else if (status === "input_required" && was !== "input_required") setText("The assistant needs your input.");
    else if (status === "ready" && (was === "streaming" || was === "submitted") && reply) setText(`The assistant replied: ${reply}`);
  }, [status, reply]);
  return <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{text}</div>;
}

/** Follow new content while at the bottom; stay put (and offer a way back) once scrolled up. */
function useStickToBottom(messages: ChatMessage[]): { scroller: RefObject<HTMLDivElement | null>; content: RefObject<HTMLDivElement | null>; atBottom: boolean; toBottom(smooth?: boolean): void } {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const bottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const toBottom = useCallback((smooth = false) => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    bottom.current = true;
    setAtBottom(true);
  }, []);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onScroll = () => {
      bottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      setAtBottom(bottom.current);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { if (bottom.current) toBottom(); });
    if (content.current) observer?.observe(content.current);
    return () => { element.removeEventListener("scroll", onScroll); observer?.disconnect(); };
  }, [toBottom]);
  const last = messages.at(-1);
  useLayoutEffect(() => { if (last?.role === "user") toBottom(); }, [last?.id, last?.role, toBottom]);
  return { scroller, content, atBottom, toBottom };
}
