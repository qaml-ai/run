import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useAgentStatus, useSend } from "../index.tsx";
import { cx, useUI } from "./context.tsx";

export interface ComposerProps {
  placeholder?: string;
  autoFocus?: boolean;
  /** What a message sent while the agent works does (the chat's own setting by default). */
  whileRunning?: "queue" | "steer";
  /** JSON sent with each message, for your handler's `onSend`. */
  data?: unknown | (() => unknown);
  className?: string;
  /** Called after a message is sent. */
  onSend?: (text: string) => void;
}
export interface ComposerHandle { focus(): void; setText(text: string): void }

/**
 * The message box: Enter sends, Shift+Enter makes a new line, Escape stops the agent. While the agent
 * works, an empty box offers Stop; typing turns it back into Send.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({ placeholder, autoFocus, whileRunning, data, className, onSend }, ref) {
  const { labels } = useUI();
  const send = useSend();
  const { isRunning, stop } = useAgentStatus();
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus(), setText }), []);
  // Grow with the text, up to the height the stylesheet allows.
  useLayoutEffect(() => {
    const element = area.current;
    if (!element || typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content")) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const message = text.trim();
    if (!message) { if (isRunning) void stop(); return; }
    setText("");
    const extra = typeof data === "function" ? (data as () => unknown)() : data;
    void send(message, { ...(extra !== undefined ? { data: extra } : {}), ...(whileRunning ? { whileRunning } : {}) });
    onSend?.(message);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
    else if (event.key === "Escape" && isRunning) { event.preventDefault(); void stop(); }
  };
  const stopping = isRunning && !text.trim();
  return (
    <form className={cx("agent-chat__composer", className)} onSubmit={submit}>
      <textarea
        ref={area} rows={1} value={text} autoFocus={autoFocus}
        placeholder={placeholder ?? labels.placeholder} aria-label={labels.composer}
        onChange={event => setText(event.currentTarget.value)} onKeyDown={onKeyDown}
      />
      <button type="submit" className={cx("agent-chat__send", stopping && "agent-chat__send--stop")} disabled={!stopping && !text.trim()} aria-label={stopping ? labels.stop : labels.send}>
        <span aria-hidden="true" className="agent-chat__send-icon" />
      </button>
    </form>
  );
});
