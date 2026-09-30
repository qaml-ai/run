import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AssistantChatMessage, AssistantPart, ChatMessage, UserChatMessage } from "@camelai/run/chat";
import { useAgent, useAgentSelector, useAgentStatus, useLoadOlder, useMessages } from "../index.tsx";
import { cx, useUI } from "./context.tsx";
import { ToolView } from "./tool.tsx";

/** A user's message: its text, who sent it (in a shared chat), and whether it was sent. */
export const UserMessage = memo(function UserMessage({ message }: { message: UserChatMessage }) {
  const { labels } = useUI();
  const chat = useAgent();
  return (
    <div className="agent-chat__message agent-chat__message--user" data-status={message.status}>
      {message.from?.name && <div className="agent-chat__author">{message.from.name}</div>}
      <div className="agent-chat__bubble">
        {message.parts.map(part => part.type === "text"
          ? <p key={part.id} className="agent-chat__user-text">{part.text}</p>
          : <img key={part.id} src={part.url} alt="" className="agent-chat__user-image" />)}
      </div>
      {message.status === "sending" && <div className="agent-chat__note">{labels.sending}</div>}
      {message.status === "failed" && (
        <div className="agent-chat__note agent-chat__note--error" role="alert">
          {message.error?.message ?? labels.failed}{" "}
          <button type="button" className="agent-chat__link-button" onClick={() => void chat.retry(message.id)}>{labels.retry}</button>
        </div>
      )}
    </div>
  );
});

/** The agent's turn: its text, reasoning, tool calls, questions and files, in order. */
export const AssistantMessage = memo(function AssistantMessage({ message }: { message: AssistantChatMessage }) {
  const { labels } = useUI();
  const last = message.parts.at(-1);
  return (
    <div className="agent-chat__message agent-chat__message--assistant" data-streaming={message.streaming || undefined}>
      {message.parts.map(part => <Part key={part.id} part={part} streaming={message.streaming && part === last} />)}
      {message.stopReason === "aborted" && <div className="agent-chat__note">{labels.stopped}</div>}
      {message.stopReason === "error" && <div className="agent-chat__note agent-chat__note--error">{message.error ?? labels.failed}</div>}
    </div>
  );
});

const Part = memo(function Part({ part, streaming }: { part: AssistantPart; streaming: boolean }) {
  const { components, showReasoning, labels } = useUI();
  switch (part.type) {
    case "text": return <components.Markdown text={part.text} streaming={streaming && part.streaming} />;
    case "reasoning": return showReasoning && !part.redacted ? (
      <details className="agent-chat__reasoning" data-streaming={part.streaming || undefined}>
        <summary>{part.streaming ? labels.thinking : labels.reasoning}</summary>
        <div className="agent-chat__reasoning-text">{part.text}</div>
      </details>
    ) : null;
    case "tool": return <ToolView part={part} />;
    case "file": return <components.FilePreview part={part} />;
    default: return null;
  }
});

const Row = memo(function Row({ message }: { message: ChatMessage }) {
  const { components } = useUI();
  return message.role === "user" ? <components.UserMessage message={message} /> : <components.AssistantMessage message={message} />;
});

/** How close to the bottom (px) still counts as at the bottom. */
const NEAR = 48;

/**
 * The conversation: follows the reply while you are at the bottom, stays put when you scroll up
 * (with a button back to the latest), and keeps your place when older messages load above.
 */
export function MessageList({ className, children, suggestions = [] }: { className?: string; children?: ReactNode; suggestions?: string[] }) {
  const { labels, components } = useUI();
  const chat = useAgent();
  const messages = useMessages();
  const { status } = useAgentStatus();
  const { hasOlder, loading, loadOlder } = useLoadOlder();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const anchor = useRef<{ height: number; top: number } | null>(null);

  const toBottom = useCallback((smooth = false) => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTo?.({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    if (!element.scrollTo) element.scrollTop = element.scrollHeight;
    atBottom.current = true;
    setShowJump(false);
  }, []);
  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR;
    setShowJump(!atBottom.current);
    if (element.scrollTop < 64 && hasOlder && !loading) void older();
  };
  const older = async () => {
    const element = scroller.current;
    if (element) anchor.current = { height: element.scrollHeight, top: element.scrollTop };
    await loadOlder();
  };
  // After older messages land above, keep what was on screen where it was.
  useLayoutEffect(() => {
    const element = scroller.current, kept = anchor.current;
    if (!element || !kept || loading) return;
    anchor.current = null;
    element.scrollTop = kept.top + element.scrollHeight - kept.height;
  }, [messages, loading]);
  // Follow new content (and a message just sent) while at the bottom.
  const lastId = messages.at(-1)?.id;
  const lastIsMine = messages.at(-1)?.role === "user";
  useLayoutEffect(() => { if (lastIsMine) toBottom(); }, [lastId, lastIsMine, toBottom]);
  useEffect(() => {
    const element = content.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (atBottom.current && !anchor.current) toBottom(); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [toBottom]);
  useLayoutEffect(() => { if (atBottom.current && !anchor.current) toBottom(); }, [messages, toBottom]);

  const waiting = status === "submitted" && !messages.some(message => message.role === "assistant" && message.streaming);
  const empty = !messages.length && status !== "connecting";
  return (
    <div className={cx("agent-chat__viewport", className)}>
      <div ref={scroller} className="agent-chat__messages" role="log" aria-label={labels.conversation} aria-live="off" tabIndex={0} onScroll={onScroll}>
        <div ref={content} className="agent-chat__content">
          {hasOlder && (
            <button type="button" className="agent-chat__older" onClick={() => void older()} disabled={loading}>{loading ? labels.loadingOlder : labels.loadOlder}</button>
          )}
          {empty && <components.EmptyState suggestions={suggestions} send={text => void chat.send(text)} />}
          {messages.map(message => <Row key={message.id} message={message} />)}
          {waiting && <div className="agent-chat__thinking" aria-hidden="true"><span /><span /><span /><span className="agent-chat__thinking-text">{labels.thinking}</span></div>}
          {children}
        </div>
      </div>
      {showJump && (
        <button type="button" className="agent-chat__jump" onClick={() => toBottom(true)}>{labels.jumpToLatest}</button>
      )}
      <Announcer />
    </div>
  );
}

/**
 * Tells screen readers what happens without reading every streamed token: that the assistant is
 * responding, then its finished reply, and when it needs input.
 */
function Announcer() {
  const { labels } = useUI();
  const status = useAgentSelector(snapshot => snapshot.status);
  const lastReply = useAgentSelector(snapshot => {
    const last = snapshot.messages.at(-1);
    return last?.role === "assistant" && !last.streaming ? last : null;
  });
  const [text, setText] = useState("");
  const previous = useRef(status);
  const seen = useRef(lastReply?.id);
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (status === "streaming" && was !== "streaming") setText(labels.responding);
    else if (status === "input_required" && was !== "input_required") setText(labels.needsInput);
    else if (status === "ready" && lastReply && (was === "streaming" || was === "submitted") && seen.current !== lastReply.id + lastReply.parts.length) {
      seen.current = lastReply.id + lastReply.parts.length;
      const reply = lastReply.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").slice(0, 1000);
      if (reply) setText(`${labels.replied} ${reply}`);
    }
  }, [status, lastReply, labels]);
  return <div className="agent-chat__sr-only" role="status" aria-live="polite" aria-atomic="true">{text}</div>;
}

export function EmptyState({ suggestions, send }: { suggestions: string[]; send(text: string): void }) {
  const { labels } = useUI();
  return (
    <div className="agent-chat__empty">
      <p className="agent-chat__empty-title">{labels.emptyTitle}</p>
      {suggestions.length > 0 && (
        <ul className="agent-chat__suggestions">
          {suggestions.map(suggestion => <li key={suggestion}><button type="button" className="agent-chat__suggestion" onClick={() => send(suggestion)}>{suggestion}</button></li>)}
        </ul>
      )}
    </div>
  );
}
