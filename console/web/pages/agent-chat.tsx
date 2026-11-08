import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentProvider, useAgent, useAgentChat, useAgentStatus } from "@camelai/run-react";
import type { ChildAgent } from "../../../clients/typescript";
import { AgentChatView } from "../../../packages/registry/src/agent-chat/agent-chat";
import { Button } from "@/components/ui/button";
import { api, putFile } from "@/lib/api";
import { Link } from "@/lib/router";

/** Adapt the app-handler protocol to the owner's cookie-authenticated API. No browser tokens
 * or new server routes: the SDK still owns history, event replay, streaming and input state. */
export function consoleChatFetch(agentId: string, changed: () => void, request: typeof fetch = fetch): typeof fetch {
  const base = `/v1/agents/${encodeURIComponent(agentId)}`;
  return async (input, init = {}) => {
    const url = new URL(String(input), location.origin);
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    if (init.method !== "POST") return request(url.pathname + url.search, { ...init, headers, credentials: "same-origin" });
    const body = JSON.parse(String(init.body));
    if (body.action === "token") return Response.json({ agentId, token: "console-session", url: location.origin });
    headers.set("X-Agent-Runtime-Console", "1");
    headers.set("Content-Type", "application/json");
    const action = body.action;
    const path = action === "send" ? "/prompt" : action === "stop" ? "/abort" : action === "answer" ? `/inputs/${encodeURIComponent(body.inputId)}` : action === "link" ? "/links" : null;
    if (!path) return Response.json({ error: "Unsupported chat action" }, { status: 400 });
    const payload = action === "send" ? { text: body.text, requestId: body.clientId, whileRunning: body.whileRunning ?? "queue", ...(body.data?.files ? { files: body.data.files } : {}) }
      : action === "answer" ? body.answer : action === "link" ? { path: body.path, method: "GET" } : {};
    const response = await request(base + path, { ...init, headers, credentials: "same-origin", body: JSON.stringify(payload) });
    changed();
    if (action === "answer" && response.ok) window.dispatchEvent(new Event("inbox-changed"));
    return response;
  };
}

export function ConsoleAgentChat({ agentId }: { agentId: string }) {
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const resize = () => { if (frame.current) frame.current.style.height = `calc(100dvh - ${Math.max(0, frame.current.getBoundingClientRect().top)}px - 16px)`; };
    resize(); window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [children, setChildren] = useState<ChildAgent[]>([]);
  const [queued, setQueued] = useState(0);
  const [refreshError, setRefreshError] = useState<string>();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const refresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      const version = ++generation.current;
      void Promise.all([api<{ children: ChildAgent[] }>(`/v1/agents/${agentId}/children`), api<{ queuedRuns?: number }>(`/v1/agents/${agentId}/state`)]).then(([result, state]) => {
        if (version !== generation.current) return;
        setChildren(result.children); setQueued(state.queuedRuns ?? 0); setRefreshError(undefined);
      }, error => { if (version === generation.current) setRefreshError(error.message); });
    }, 100);
  }, [agentId]);
  useEffect(() => { refresh(); return () => { clearTimeout(refreshTimer.current); generation.current++; }; }, [refresh]);
  const chat = useAgentChat({ endpoint: `/v1/agents/${agentId}`, fetch: consoleChatFetch(agentId, refresh), watch: { transport: "sse", subagents: true },
    onEvent: event => { if (event.type !== "message_update") refresh(); } });
  useEffect(() => {
    const target = new URLSearchParams(location.search).get("input");
    if (!target) return;
    let found = false;
    const reveal = () => {
      if (found) return;
      requestAnimationFrame(() => {
        const card = document.getElementById(`input-${target}`);
        if (card) { card.scrollIntoView({ block: "center" }); found = true; }
      });
    };
    reveal();
    return chat.subscribe(reveal);
  }, [chat]);
  return <div ref={frame} className="min-h-80"><AgentProvider chat={chat}>
    <AgentChatView className="rounded-xl border" composer={<ConsoleComposer />} activity={<Activity queued={queued} />}>
      {refreshError && <p role="alert" className="text-sm text-destructive">Could not update workers: {refreshError}</p>}
      {children.length > 0 && <section aria-label="Workers" className="space-y-2">{children.map(child => <Worker key={child.agentId + child.requestId} child={child} />)}</section>}
    </AgentChatView>
  </AgentProvider></div>;
}
function Activity({ queued }: { queued: number }) {
  const { status, connected, isRunning } = useAgentStatus();
  return <p role="status" className="mx-auto w-full max-w-3xl px-4 py-2 text-xs text-muted-foreground">{!connected ? "Connecting…" : status === "input_required" ? "Waiting for your answer" : isRunning ? "Working on your message" : "Ready"}{queued > 0 && ` · ${queued} queued`}</p>;
}
function Worker({ child }: { child: ChildAgent }) {
  return <details className="rounded-lg border p-3 text-sm" data-status={child.status}>
    <summary className="cursor-pointer">{child.name} · {child.status === "running" ? "Working…" : child.status.replaceAll("_", " ")}</summary>
    {child.progress && <p className="mt-2 whitespace-pre-wrap">{child.progress}</p>}
    {child.error && <p className="text-destructive">{child.error}</p>}
    <Link className="mt-2 inline-block underline" to={`agents/${child.agentId}`}>Open worker conversation</Link>
  </details>;
}
export function ConsoleComposer() {
  const chat = useAgent();
  const { isRunning, status, stop } = useAgentStatus();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const upload = useRef<HTMLInputElement>(null);
  async function send() {
    if (busy || !text.trim()) return;
    setBusy(true); setError(undefined);
    try {
      const id = crypto.randomUUID();
      const attached = [];
      for (const file of files) attached.push({ path: (await putFile(`/v1/agents/${chat.getSnapshot().agentId}/uploads/${id}/${encodeURIComponent(file.name)}`, file)).path });
      await chat.send(text.trim(), { whileRunning: mode, data: { files: attached } });
      if (!chat.getSnapshot().error) { setText(""); setFiles([]); }
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <form className="mx-auto w-full max-w-3xl shrink-0 space-y-2 p-3 pb-[max(.75rem,env(safe-area-inset-bottom))]" onSubmit={event => { event.preventDefault(); void send(); }}>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {files.map((file, index) => <button type="button" key={index} disabled={busy} className="mr-2 text-xs underline" aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, at) => at !== index))}>{file.name} ×</button>)}
    <textarea aria-label="Message" rows={2} className="max-h-48 w-full resize-y rounded-lg border bg-background p-3 text-sm" placeholder="Message the agent…" value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
    <input type="file" multiple hidden ref={upload} onChange={event => { setFiles([...files, ...event.target.files ?? []]); event.target.value = ""; }} />
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => upload.current?.click()}>Attach files</Button>
      {isRunning && <select aria-label="While working" value={mode} onChange={event => setMode(event.target.value as typeof mode)} className="min-w-0 rounded border bg-background p-1 text-sm"><option value="queue">Queue message</option><option value="steer">Steer agent</option></select>}
      <div className="flex-1" />
      {(isRunning || status === "input_required") && <Button type="button" variant="outline" size="sm" onClick={() => void stop()}>Stop</Button>}
      <Button size="sm" disabled={busy || status === "connecting" || !text.trim()}>{busy ? "Sending…" : isRunning ? mode === "queue" ? "Queue" : "Steer" : "Send"}</Button>
    </div>
  </form>;
}
