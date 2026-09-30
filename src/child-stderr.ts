import { errorClass } from "./metrics.ts";

/** The line's error or warning name, e.g. TypeError or ExperimentalWarning. */
const NAME = /\b([A-Z][A-Za-z]{0,40}(?:Error|Exception|Warning))\b/;
/** Where in the runtime's code, or a package's, a stack frame is: a path and line, never the frame's text. */
const FRAME = /((?:src|shared)\/[\w./-]+\.ts|node_modules\/[@\w./-]+\.[cm]?js):(\d+):\d+/;

/**
 * An agent process's stderr, as the node's log keeps it. Its own lines (metric and diagnostic JSON, with a `type`)
 * pass as they are: tests/log-privacy.test.ts checks what they hold. Anything else, a crash's stack trace or a
 * library's warning, can carry what the model or a user wrote, so each message and its stack frames become one line:
 * the error's name and class, the first frame in the runtime's code or a package, and the text's size.
 */
export function childStderr(agent: string, write: (line: string) => void = line => process.stderr.write(line)) {
  let buffer = "";
  let pending: { name: string; class: string; at?: string; lines: number; bytes: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (pending) write(`${JSON.stringify({ type: "agent_stderr", agent, ...pending })}\n`);
    pending = undefined;
  };
  const line = (text: string) => {
    if (!text.trim()) return;
    if (text.startsWith("{")) {
      let value: unknown;
      try { value = JSON.parse(text); } catch { /* not the process's own line */ }
      if (value && typeof (value as { type?: unknown }).type === "string") { flush(); write(`${text}\n`); return; }
    }
    const frame = /^\s+at\s/.test(text);
    if (!frame || !pending) { flush(); pending = { name: NAME.exec(text)?.[1] ?? "text", class: errorClass(text), lines: 0, bytes: 0 }; }
    pending.lines++;
    pending.bytes += Buffer.byteLength(text);
    if (frame && !pending.at) {
      const at = FRAME.exec(text);
      if (at) pending.at = `${at[1]}:${at[2]}`;
    }
    // A trace's frames arrive together: the line goes out once they stop.
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 100);
    timer.unref?.();
  };
  return {
    data(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      // A line that never ends is cut, not held whole.
      if (buffer.length > 64 * 1024) { lines.push(buffer); buffer = ""; }
      for (const text of lines) line(text);
    },
    end() { if (buffer) line(buffer); buffer = ""; flush(); },
  };
}
