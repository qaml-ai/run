import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentProvider, useAgent, useAgentChat, useAgentStatus, useMessages, type ToolRenderProps } from "@camelai/run-react";
import type { ChildAgent } from "../../../clients/typescript";
import { AgentTool, AgentWorker } from "../../../packages/registry/src/agent-chat/agent-parts";
import { AgentMarkdown } from "../../../packages/registry/src/agent-chat/agent-markdown";
import { AgentChatView } from "../../../packages/registry/src/agent-chat/agent-chat";
import { Paperclip, Square } from "lucide-react";
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

export function ConsoleAgentChat({ agentId, description }: { agentId: string; description?: string }) {
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const resize = () => {
      if (!frame.current) return;
      const viewport = window.visualViewport;
      const bottom = (viewport?.height ?? window.innerHeight) + (viewport?.offsetTop ?? 0);
      frame.current.style.height = `${Math.max(0, bottom - frame.current.getBoundingClientRect().top - 16)}px`;
    };
    const observer = new ResizeObserver(resize);
    for (let element = frame.current?.parentElement; element; element = element.parentElement) observer.observe(element);
    resize(); window.addEventListener("resize", resize); window.visualViewport?.addEventListener("resize", resize);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize); };
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
  useEffect(() => { refresh(); return () => { clearTimeout(refreshTimer.current); refreshTimer.current = undefined; generation.current++; }; }, [refresh]);
  const chat = useAgentChat({ endpoint: `/v1/agents/${agentId}`, fetch: consoleChatFetch(agentId, refresh), watch: { transport: "sse", subagents: true },
    onEvent: event => { if (event.type !== "message_update") refresh(); } });
  useEffect(() => {
    const target = new URLSearchParams(location.search).get("input");
    if (!target) return;
    let found = false;
    const reveal = () => {
      if (found) return;
      requestAnimationFrame(() => {
        const card = Array.from(document.querySelectorAll<HTMLElement>("[data-input-id]")).find(element => element.dataset.inputId === target);
        if (card) { card.scrollIntoView({ block: "center" }); found = true; }
      });
    };
    reveal();
    return chat.subscribe(reveal);
  }, [chat]);
  return <div ref={frame} className="console-agent-chat min-h-0"><AgentProvider chat={chat}>
    <ChatThread children={children} queued={queued} error={refreshError} suggestions={suggestedPrompts(description)} />
  </AgentProvider></div>;
}
function Activity({ queued }: { queued: number }) {
  const { status, connected, isRunning } = useAgentStatus();
  return <p role="status" className="mx-auto w-full max-w-[760px] px-4 py-2 text-xs text-muted-foreground">{!connected ? "Connecting…" : status === "input_required" ? "Waiting for your answer" : isRunning ? "Working on your message" : "Ready"}{queued > 0 && ` · ${queued} queued`}</p>;
}
function ChatThread({ children, queued, error, suggestions }: { children: ChildAgent[]; queued: number; error?: string; suggestions: string[] }) {
  const messages = useMessages();
  const calls = messages.flatMap(message => message.role === "assistant" ? message.parts.filter(part => part.type === "tool") : []);
  const childFor = (part: (typeof calls)[number]) => children.find(child => child.toolCallId === part.id || child.agentId === part.subagent?.agentId);
  const shown = new Set(calls.flatMap(part => childFor(part) ? [childFor(part)!.agentId] : []));
  const tools = Object.fromEntries(calls.filter(part => childFor(part)).map(part => [part.name, ({ part }: ToolRenderProps) => {
    const child = childFor(part);
    return child ? <Worker child={child} result={part.result?.text} /> : <AgentTool part={part} />;
  }]));
  return <AgentChatView className="rounded-xl border" suggestions={suggestions} senderLabel={message => message.from?.name ?? "You"} tools={tools} composer={<ConsoleComposer />} activity={<Activity queued={queued} />}>
    {error && <p role="alert" className="text-sm text-destructive">Could not update workers: {error}</p>}
    {children.filter(child => !shown.has(child.agentId)).map(child => <Worker key={child.agentId + child.requestId} child={child} />)}
  </AgentChatView>;
}
function Worker({ child, result }: { child: ChildAgent; result?: string }) {
  return <AgentWorker name={child.name} status={child.status} progress={child.progress} startedAt={child.startedAt} endedAt={child.endedAt}>
    {result && <AgentMarkdown text={result} />}
    {child.error && <p className="text-destructive">{child.error}</p>}
    <Link className="mt-2 inline-block underline" to={`agents/${child.agentId}`}>Open worker conversation</Link>
  </AgentWorker>;
}
/** Keep the definition's own words in the first starter; the other starters work for any role. */
export function suggestedPrompts(description?: string): string[] {
  const context = description?.replace(/\s+/g, " ").trim();
  return [context ? `Help me get started: ${context.slice(0, 180)}` : "What can you help me with?", "What information do you need from me?", "Suggest a first step"];
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
  async function send(whileRunning = mode) {
    if (busy || !text.trim()) return;
    setBusy(true); setError(undefined);
    try {
      const id = crypto.randomUUID();
      const attached = [];
      for (const file of files) attached.push({ path: (await putFile(`/v1/agents/${chat.getSnapshot().agentId}/uploads/${id}/${encodeURIComponent(file.name)}`, file)).path });
      await chat.send(text.trim(), { whileRunning, data: { files: attached } });
      if (!chat.getSnapshot().error) { setText(""); setFiles([]); setMode("queue"); }
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <form className="mx-auto w-full max-w-[760px] shrink-0 px-4 pb-[max(.75rem,env(safe-area-inset-bottom))]" onSubmit={event => { event.preventDefault(); void send(); }}>
    {error && <p role="alert" className="mb-2 text-sm text-destructive">{error}</p>}
    <div className="rounded-2xl border bg-background p-2 focus-within:ring-1 focus-within:ring-ring">
      {files.map((file, index) => <button type="button" key={index} disabled={busy} className="mx-2 text-xs underline" aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, at) => at !== index))}>{file.name} ×</button>)}
      <textarea disabled={busy} aria-label="Message" rows={2} className="max-h-48 min-h-16 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none [field-sizing:content]" placeholder="Message the agent…" value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(event.altKey ? "steer" : mode); } }} />
      <input type="file" multiple hidden ref={upload} onChange={event => { setFiles([...files, ...event.target.files ?? []]); event.target.value = ""; }} />
      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Attach files" title="Attach files" disabled={busy} onClick={() => upload.current?.click()}><Paperclip className="size-4" /></Button>
        {isRunning && <button type="button" aria-pressed={mode === "steer"} title="Send immediately to steer the agent (Alt+Enter)" className="rounded-md px-2 py-1 text-xs text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground" onClick={() => setMode(mode === "queue" ? "steer" : "queue")}>Steer instead</button>}
        <div className="flex-1" />
        {(isRunning || status === "input_required") && <Button type="button" variant="ghost" size="icon-sm" aria-label="Stop" title="Stop agent" onClick={() => void stop()}><Square className="size-4" /></Button>}
        <Button size="sm" disabled={busy || status === "connecting" || !text.trim()}>{busy ? "Sending…" : "Send"}</Button>
      </div>
    </div>
  </form>;
}
