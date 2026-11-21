import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Loader2, Paperclip, Square } from "lucide-react";
import { AgentMarkdown } from "../../../packages/registry/src/agent-chat/agent-markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  api,
  v2Path,
  type AgentEventRecord,
  type PendingInputView,
  type RunRecord,
  type StoredMessage,
} from "@/lib/api";

interface LiveToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  status: "running" | "done" | "error";
  result?: string;
}

export function suggestedPrompts(instructions?: string): string[] {
  const context = instructions?.replace(/\s+/g, " ").trim();
  return [
    context ? `Help me get started: ${context.slice(0, 140)}` : "What can you help me with?",
    "What information do you need from me?",
    "Suggest a first step",
  ];
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** Parses an SSE ReadableStream into individual event records. */
async function consumeSse(
  response: Response,
  onEvent: (event: AgentEventRecord) => void,
  signal: AbortSignal,
) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const flush = () => {
    if (!dataLines.length) return;
    const raw = dataLines.join("\n");
    dataLines = [];
    if (!raw || raw === "[DONE]") return;
    try {
      const parsed = JSON.parse(raw) as AgentEventRecord;
      if (parsed && typeof parsed.type === "string") onEvent(parsed);
    } catch {
      // ignore heartbeat/malformed chunks
    }
  };

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          flush();
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) {
          const rest = line.slice(5);
          dataLines.push(rest.startsWith(" ") ? rest.slice(1) : rest);
        }
      }
    }
    flush();
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

function PendingInputCard({
  agentId,
  input,
  onResolved,
}: {
  agentId: string;
  input: PendingInputView;
  onResolved: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function respond(payload: { approved?: boolean; answer?: unknown }) {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/v2/agents/${encodeURIComponent(agentId)}/inputs/${encodeURIComponent(input.id)}`, {
        method: "POST",
        body: { ...payload, wait: false },
      });
      onResolved();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const promptObj = input.prompt ?? {};
  const questionText =
    typeof promptObj.question === "string"
      ? promptObj.question
      : typeof promptObj.message === "string"
        ? promptObj.message
        : typeof promptObj.tool === "string"
          ? `Approve tool call "${promptObj.tool}"?`
          : input.kind === "approval"
            ? "Approve this action?"
            : "The agent needs your input";

  return (
    <div data-input-id={input.id} className="bg-card space-y-3 border p-4 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant="info">{input.kind}</Badge>
        <span className="font-medium">{questionText}</span>
      </div>
      {promptObj.args !== undefined && (
        <pre className="bg-muted max-h-40 overflow-auto p-2 font-mono text-xs">
          {JSON.stringify(promptObj.args, null, 2)}
        </pre>
      )}
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
      {input.kind === "approval" ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => void respond({ approved: true })}>
            {busy && <Loader2 className="animate-spin" />}Approve
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void respond({ approved: false })}>
            Deny
          </Button>
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (!answer.trim()) return;
            void respond({ approved: true, answer: answer.trim() });
          }}
        >
          <Input
            placeholder="Type your answer…"
            value={answer}
            disabled={busy}
            onChange={event => setAnswer(event.target.value)}
          />
          <Button size="sm" type="submit" disabled={busy || !answer.trim()}>
            {busy && <Loader2 className="animate-spin" />}Reply
          </Button>
        </form>
      )}
    </div>
  );
}

export function ConsoleAgentChat({
  agentId,
  repoId,
  branch,
  instructions,
  onAgentChanged,
}: {
  agentId: string;
  repoId: string | null;
  branch: string;
  instructions?: string;
  onAgentChanged?: () => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const resize = () => {
      if (!frame.current) return;
      const viewport = window.visualViewport;
      const bottom = (viewport?.height ?? window.innerHeight) + (viewport?.offsetTop ?? 0);
      frame.current.style.height = `${Math.max(320, bottom - frame.current.getBoundingClientRect().top - 16)}px`;
    };
    const observer = new ResizeObserver(resize);
    for (let el = frame.current?.parentElement; el; el = el.parentElement) observer.observe(el);
    resize();
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, []);

  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [compaction, setCompaction] = useState<{ id: string; upToSeq: number; summary: string } | null>(null);
  const [pendingInputs, setPendingInputs] = useState<PendingInputView[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [liveTools, setLiveTools] = useState<LiveToolCall[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const fileInput = useRef<HTMLInputElement>(null);

  const cursorRef = useRef(0);

  const loadSnapshot = useCallback(async () => {
    try {
      const [history, runState, inputsRes] = await Promise.all([
        api<{ messages: StoredMessage[]; compaction: { id: string; upToSeq: number; summary: string } | null }>(
          `/v2/agents/${encodeURIComponent(agentId)}/history?before=latest&limit=200`,
        ),
        api<{ cursor: number; activeRunId: string | null; runs: RunRecord[] }>(
          `/v2/agents/${encodeURIComponent(agentId)}/runs`,
        ),
        api<{ runs: RunRecord[] }>(`/v2/agents/${encodeURIComponent(agentId)}/inputs`),
      ]);
      setMessages(history.messages ?? []);
      setCompaction(history.compaction ?? null);
      const activeRuns = (runState.runs ?? []).filter(r => r.status === "running");
      const queued = (runState.runs ?? []).filter(r => r.status === "queued").length;
      setIsRunning(Boolean(runState.activeRunId) || activeRuns.length > 0);
      setQueuedCount(queued);
      setPendingInputs((inputsRes.runs ?? []).flatMap(r => r.inputs ?? []).filter(i => i.status === "pending"));
      if (runState.cursor > cursorRef.current) cursorRef.current = runState.cursor;
      setLoadError(undefined);
    } catch (caught) {
      setLoadError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  // Initial load + live SSE subscription via /console/v2/agents/:id/events?after=...&follow=1
  useEffect(() => {
    const controller = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const handleEvent = (ev: AgentEventRecord) => {
      if (typeof ev.seq === "number" && ev.seq > cursorRef.current) cursorRef.current = ev.seq;
      const data = ev.data ?? {};
      switch (ev.type) {
        case "run_started":
        case "run_resumed":
          setIsRunning(true);
          setStreamingText("");
          setLiveTools([]);
          break;
        case "run_queued":
          setQueuedCount(c => c + 1);
          break;
        case "text_delta":
          if (typeof data.delta === "string") {
            setIsRunning(true);
            setStreamingText(prev => prev + data.delta);
          }
          break;
        case "tool_call_start": {
          const callId = String(data.callId ?? data.id ?? Math.random());
          const name = String(data.name ?? "tool");
          const args = data.args && typeof data.args === "object" ? (data.args as Record<string, unknown>) : undefined;
          setLiveTools(prev => [...prev.filter(t => t.id !== callId), { id: callId, name, args, status: "running" }]);
          break;
        }
        case "tool_call_end": {
          const callId = String(data.callId ?? data.id ?? "");
          const ok = data.ok !== false;
          const resultText = typeof data.result === "string"
            ? data.result
            : data.result !== undefined
              ? JSON.stringify(data.result, null, 2)
              : undefined;
          setLiveTools(prev =>
            prev.map(t => (t.id === callId ? { ...t, status: ok ? "done" : "error", result: resultText } : t)),
          );
          break;
        }
        case "run_completed":
        case "run_failed":
        case "run_cancelled":
        case "input_required":
        case "input_resolved":
        case "context_compacted":
        case "context_reset":
          setStreamingText("");
          setLiveTools([]);
          void loadSnapshot();
          onAgentChanged?.();
          break;
      }
    };

    const connect = async () => {
      await loadSnapshot();
      while (!controller.signal.aborted) {
        try {
          const res = await fetch(
            v2Path(`/v2/agents/${encodeURIComponent(agentId)}/events?after=${cursorRef.current}&follow=1`),
            {
              headers: { Accept: "text/event-stream" },
              credentials: "same-origin",
              signal: controller.signal,
            },
          );
          if (!res.ok) throw new Error(`Stream HTTP ${res.status}`);
          setConnected(true);
          await consumeSse(res, handleEvent, controller.signal);
        } catch {
          if (controller.signal.aborted) break;
          setConnected(false);
        }
        if (controller.signal.aborted) break;
        await new Promise<void>(resolve => {
          reconnectTimer = setTimeout(resolve, 1500);
        });
      }
    };

    void connect();
    return () => {
      controller.abort();
      clearTimeout(reconnectTimer);
    };
  }, [agentId, loadSnapshot, onAgentChanged]);

  // Auto-scroll to bottom when messages or streaming text grow
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText, liveTools.length, pendingInputs.length]);

  async function sendPrompt(textToSend = draft, whileRunning = mode) {
    const clean = textToSend.trim();
    if (sending || !clean) return;
    setSending(true);
    setSendError(undefined);
    try {
      let attachedFiles: { path: string; commit: string; contentType: string }[] | undefined;
      if (files.length > 0) {
        let targetRepoId = repoId;
        let targetRef = branch || "refs/heads/main";
        if (!targetRepoId) {
          const ensured = await api<{ repoId: string; branch: string }>(`/v2/agents/${encodeURIComponent(agentId)}/repo`, {
            method: "PUT",
            body: {},
          });
          targetRepoId = ensured.repoId;
          targetRef = ensured.branch || targetRef;
          onAgentChanged?.();
        }
        const puts = await Promise.all(
          files.map(async file => ({
            path: `uploads/${Date.now()}-${file.name}`,
            base64: await fileToBase64(file),
          })),
        );
        const written = await api<{ commit: string }>(`/v2/repos/${encodeURIComponent(targetRepoId)}/write`, {
          method: "POST",
          body: { ref: targetRef, message: "console attachment upload", puts },
        });
        attachedFiles = files.map((file, i) => ({
          path: puts[i]!.path,
          commit: written.commit,
          contentType: file.type || "application/octet-stream",
        }));
      }

      // Optimistic user bubble until history reload catches up
      const optimisticSeq = (messages.at(-1)?.seq ?? 0) + 0.5;
      setMessages(prev => [
        ...prev,
        {
          seq: optimisticSeq,
          runId: null,
          role: "user",
          content: { text: clean, ...(attachedFiles ? { files: attachedFiles } : {}) },
          tokensEst: 0,
          createdAt: Date.now(),
        },
      ]);
      setDraft("");
      setFiles([]);
      setMode("queue");
      setIsRunning(true);

      await api<RunRecord>(`/v2/agents/${encodeURIComponent(agentId)}/runs`, {
        method: "POST",
        body: {
          prompt: clean,
          whileRunning,
          wait: false,
          ...(attachedFiles ? { files: attachedFiles } : {}),
        },
      });
    } catch (caught) {
      setSendError((caught as Error).message);
      void loadSnapshot();
    } finally {
      setSending(false);
    }
  }

  async function stopRun() {
    try {
      await api(`/v2/agents/${encodeURIComponent(agentId)}/abort`, { method: "POST", body: {} });
      await loadSnapshot();
    } catch (caught) {
      setSendError((caught as Error).message);
    }
  }

  // Group tool result messages by toolCallId so assistant tool calls render with their results
  const toolResults = new Map<string, { text: string; isError?: boolean }>();
  for (const m of messages) {
    if (m.role === "tool" && m.content.toolCallId) {
      toolResults.set(m.content.toolCallId, { text: m.content.text ?? "", isError: m.content.isError });
    }
  }

  const visibleMessages = messages.filter(m => m.role === "user" || m.role === "assistant");
  const starters = suggestedPrompts(instructions);
  const statusLine = !connected && loading
    ? "Connecting…"
    : pendingInputs.length > 0
      ? "Waiting for your answer"
      : isRunning
        ? "Working on your message"
        : "Ready";

  return (
    <div ref={frame} className="console-agent-chat flex min-h-0 flex-col border bg-background">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
          {loadError && <p role="alert" className="text-destructive border border-destructive p-3 text-sm">{loadError}</p>}

          {compaction?.summary && (
            <details className="bg-muted border px-3 py-2 text-xs">
              <summary className="text-muted-foreground cursor-pointer">
                Compacted history through message #{compaction.upToSeq}
              </summary>
              <p className="mt-2 whitespace-pre-wrap">{compaction.summary}</p>
            </details>
          )}

          {!loading && visibleMessages.length === 0 && !streamingText && (
            <div className="py-12 text-center">
              <p className="text-muted-foreground mb-4 text-sm">Start a conversation with this agent.</p>
              <div className="flex flex-wrap justify-center gap-2">
                {starters.map(prompt => (
                  <button
                    key={prompt}
                    type="button"
                    className="bg-card hover:bg-accent border px-3 py-2 text-left text-xs transition-colors"
                    onClick={() => void sendPrompt(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {visibleMessages.map(msg => (
            <div key={msg.seq} className={msg.role === "user" ? "flex justify-end" : "flex flex-col gap-2"}>
              {msg.role === "user" ? (
                <div className="bg-muted max-w-[85%] border px-4 py-2.5 text-sm">
                  <div className="text-muted-foreground mb-1 text-[11px] font-medium">You</div>
                  <div className="whitespace-pre-wrap">{msg.content.text ?? ""}</div>
                  {msg.content.files && msg.content.files.length > 0 && (
                    <div className="text-muted-foreground mt-2 flex flex-wrap gap-1 font-mono text-[11px]">
                      {msg.content.files.map(f => (
                        <span key={f.path} className="bg-background border px-1.5 py-0.5">{f.path}</span>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {msg.content.toolCalls?.map(tc => {
                    const res = toolResults.get(tc.id);
                    return (
                      <details key={tc.id} className="bg-card border text-xs">
                        <summary className="text-muted-foreground flex cursor-pointer items-center gap-2 px-3 py-2">
                          <span
                            aria-hidden="true"
                            className={`size-2 ${res?.isError ? "bg-destructive" : "bg-[var(--chart-1)]"}`}
                          />
                          <span className="font-mono font-medium text-foreground">{tc.name}</span>
                        </summary>
                        <div className="space-y-2 border-t p-3">
                          <pre className="bg-muted max-h-48 overflow-auto p-2 font-mono text-xs">
                            {tc.argumentsJson || JSON.stringify(tc.args ?? {}, null, 2)}
                          </pre>
                          {res && (
                            <pre className="bg-muted max-h-48 overflow-auto p-2 font-mono text-xs">
                              {res.text.slice(0, 4000)}
                            </pre>
                          )}
                        </div>
                      </details>
                    );
                  })}
                  {msg.content.text && <AgentMarkdown text={msg.content.text} />}
                </div>
              )}
            </div>
          ))}

          {(streamingText || liveTools.length > 0) && (
            <div className="space-y-2">
              {liveTools.map(tool => (
                <details key={tool.id} className="bg-card border text-xs">
                  <summary className="text-muted-foreground flex cursor-pointer items-center gap-2 px-3 py-2">
                    <span
                      aria-hidden="true"
                      className={`size-2 ${
                        tool.status === "error"
                          ? "bg-destructive"
                          : tool.status === "done"
                            ? "bg-[var(--chart-1)]"
                            : "animate-pulse bg-muted-foreground"
                      }`}
                    />
                    <span className="font-mono font-medium text-foreground">
                      {tool.status === "running" ? `Running ${tool.name}…` : tool.name}
                    </span>
                  </summary>
                  <div className="space-y-2 border-t p-3">
                    {tool.args && (
                      <pre className="bg-muted max-h-48 overflow-auto p-2 font-mono text-xs">
                        {JSON.stringify(tool.args, null, 2)}
                      </pre>
                    )}
                    {tool.result && (
                      <pre className="bg-muted max-h-48 overflow-auto p-2 font-mono text-xs">
                        {tool.result.slice(0, 4000)}
                      </pre>
                    )}
                  </div>
                </details>
              ))}
              {streamingText && <AgentMarkdown text={streamingText} streaming />}
            </div>
          )}

          {pendingInputs.map(input => (
            <PendingInputCard key={input.id} agentId={agentId} input={input} onResolved={() => void loadSnapshot()} />
          ))}
        </div>
      </div>

      <p role="status" className="mx-auto w-full max-w-[760px] px-4 py-2 text-xs text-muted-foreground">
        {statusLine}
        {queuedCount > 0 ? ` · ${queuedCount} queued` : ""}
      </p>

      <form
        className="mx-auto w-full max-w-[760px] shrink-0 px-4 pb-3"
        onSubmit={event => {
          event.preventDefault();
          void sendPrompt();
        }}
      >
        {sendError && <p role="alert" className="text-destructive mb-2 text-sm">{sendError}</p>}
        <div className="border bg-card p-2 focus-within:ring-1 focus-within:ring-ring">
          {files.length > 0 && (
            <div className="mb-1 flex flex-wrap gap-1 px-1">
              {files.map((file, index) => (
                <button
                  type="button"
                  key={`${file.name}-${index}`}
                  disabled={sending}
                  className="bg-muted border px-2 py-0.5 font-mono text-xs"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setFiles(curr => curr.filter((_, at) => at !== index))}
                >
                  {file.name} ×
                </button>
              ))}
            </div>
          )}
          <textarea
            disabled={sending}
            aria-label="Message"
            rows={2}
            className="max-h-48 min-h-14 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none"
            placeholder="Message the agent…"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void sendPrompt(draft, event.altKey ? "steer" : mode);
              }
            }}
          />
          <input
            type="file"
            multiple
            hidden
            ref={fileInput}
            onChange={event => {
              setFiles(curr => [...curr, ...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Attach files"
              title="Attach files (uploads to agent repository)"
              disabled={sending}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip className="size-4" />
            </Button>
            {isRunning && (
              <button
                type="button"
                aria-pressed={mode === "steer"}
                title="Send immediately to steer the active run (Alt+Enter)"
                className="px-2 py-1 text-xs text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
                onClick={() => setMode(mode === "queue" ? "steer" : "queue")}
              >
                Steer instead
              </button>
            )}
            <div className="flex-1" />
            {isRunning && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Stop"
                title="Stop agent"
                onClick={() => void stopRun()}
              >
                <Square className="size-4" />
              </Button>
            )}
            <Button size="sm" type="submit" disabled={sending || !draft.trim()}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
