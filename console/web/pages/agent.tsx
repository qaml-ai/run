import { useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Braces, GitFork, Loader2, Paperclip, RefreshCw, Send, Square, Trash2, Wrench, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { StatusPanel } from "@/components/brand";
import { ConfirmButton, CopyButton, EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { FileBrowser, FileCard } from "@/components/files";
import { api, formatBytes, formatTime, putFile, useApi, type AgentDetail, type FileRef, type Mount, type RequestRecord, type RunFiles, type ToolSource } from "@/lib/api";
import { Link, navigate } from "@/lib/router";
import { AgentStatus } from "@/pages/agents";

type Part = { type: string; text?: string; thinking?: string; name?: string; arguments?: any; id?: string };
type Message = { role: string; content: string | Part[]; toolName?: string; toolCallId?: string; isError?: boolean; timestamp?: number; stopReason?: string; errorMessage?: string };
const parts = (content: Message["content"]): Part[] => typeof content === "string" ? [{ type: "text", text: content }] : content ?? [];
const text = (content: Message["content"]) => parts(content).filter(part => part.type === "text").map(part => part.text).join("\n");

/** Where a path the agent saw lives: the deepest mount containing it (of `volume`, when known). */
function locate(mounts: Mount[] | undefined, shown: string, volume?: string) {
  const mount = (mounts ?? []).filter(mount => (!volume || mount.volumeId === volume) && (shown === mount.path || shown.startsWith(`${mount.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return mount && { volume: mount.volumeId, path: `${(mount.subpath ?? "").replace(/\/$/, "")}${shown.slice(mount.path.length)}` || "/" };
}

/** A transcript's file reference, or a run's file, as a card with a thumbnail and a download. */
function RefCard({ mounts, file, caption }: { mounts?: Mount[]; file: Pick<FileRef, "path" | "contentType" | "size"> & { volume?: string }; caption?: string }) {
  const place = locate(mounts, file.path, file.volume);
  return <FileCard volume={place?.volume} path={place?.path} shown={file.path} contentType={file.contentType} size={file.size} caption={caption && <span className="whitespace-pre-wrap">{caption}</span>} />;
}
const files = (content: Message["content"]) => parts(content).filter(part => part.type === "file") as unknown as FileRef[];
const json = (value: string) => { try { return JSON.parse(value); } catch { return undefined; } };

function Conversation({ messages, mounts, onFork }: { messages: Message[]; mounts?: Mount[]; onFork?: (index: number) => void }) {
  if (!messages.length) return <EmptyState icon={<Send />} title="No messages yet">Prompts sent by your app, or from the “Try it” tab, appear here.</EmptyState>;
  // present_file's result names the file's type and size; its call has the caption.
  const presented = new Map(messages.filter(message => message.role === "toolResult" && message.toolName === "present_file" && !message.isError)
    .map(message => [message.toolCallId, json(text(message.content))]));
  return (
    <div className="flex flex-col gap-3">
      {messages.map((message, index) => {
        if (message.role === "user") return (
          <div key={index} className="ml-auto flex max-w-[85%] flex-col items-end gap-2">
            {text(message.content) && <div className="bg-muted rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">{text(message.content)}</div>}
            {files(message.content).map((file, fileIndex) => <RefCard key={fileIndex} mounts={mounts} file={file} />)}
          </div>
        );
        if (message.role === "toolResult") return message.toolName === "present_file" && !message.isError ? null : (
          <details key={index} className="rounded-md border px-3 py-2 text-xs">
            <summary className="text-muted-foreground cursor-pointer">
              Result of <span className="font-mono">{message.toolName}</span>{message.isError && <Badge variant="destructive" className="ml-2">error</Badge>}
              {files(message.content).length > 0 && <Badge variant="outline" className="ml-2">{files(message.content).length} files</Badge>}
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto font-mono whitespace-pre-wrap">{text(message.content)}</pre>
            <div className="mt-2 flex flex-col gap-2">{files(message.content).map((file, fileIndex) => <RefCard key={fileIndex} mounts={mounts} file={file} />)}</div>
          </details>
        );
        return (
          <div key={index} className="flex max-w-[85%] flex-col gap-2 text-sm">
            {parts(message.content).map((part, partIndex) => part.type === "text" ? <p key={partIndex} className="whitespace-pre-wrap">{part.text}</p>
              : part.type === "thinking" ? <p key={partIndex} className="text-muted-foreground text-xs italic whitespace-pre-wrap">{part.thinking}</p>
              : part.type === "toolCall" && part.name === "present_file" && presented.get(part.id) ? (
                <RefCard key={partIndex} mounts={mounts} file={presented.get(part.id)} caption={part.arguments?.caption} />
              ) : part.type === "toolCall" ? (
                <div key={partIndex} className="bg-muted flex items-start gap-2 border px-3 py-2 font-mono text-xs">
                  <Wrench className="mt-0.5 size-3.5 shrink-0" />
                  <span className="break-all">{part.name}({JSON.stringify(part.arguments)})</span>
                </div>
              ) : null)}
            {message.stopReason === "error" && <ErrorAlert error={message.errorMessage ?? "The model call failed"} title="Model error" />}
            {onFork && message.stopReason !== "error" && text(message.content) && (
              <Button variant="ghost" size="xs" className="text-muted-foreground self-start" onClick={() => onFork(index)}><GitFork />Fork from here</Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Files a run handed over (with captions), and the paths it wrote. */
function RunOutputs({ mounts, result }: { mounts?: Mount[]; result?: RunFiles }) {
  if (!result?.presented?.length && !result?.files?.length) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {result.presented?.map(file => <RefCard key={file.path} mounts={mounts} file={file} caption={file.caption} />)}
      {!!result.files?.length && (
        <details className="text-xs"><summary className="text-muted-foreground cursor-pointer">Wrote {result.files.length} files</summary>
          <ul className="mt-1 font-mono">{result.files.map(file => <li key={file.path}>{file.path} <span className="text-muted-foreground">({formatBytes(file.size)}, v{file.version})</span></li>)}</ul>
        </details>
      )}
    </div>
  );
}

function Requests({ requests, mounts }: { requests: RequestRecord[]; mounts?: Mount[] }) {
  if (!requests.length) return <p className="text-muted-foreground text-sm">No requests recorded since this agent was last loaded.</p>;
  return (
    <div className="bg-card border">
      <Table>
        <TableHeader><TableRow><TableHead>Request</TableHead><TableHead>Started</TableHead><TableHead>Outcome</TableHead></TableRow></TableHeader>
        <TableBody>
          {[...requests].reverse().map(request => (
            <TableRow key={request.id}>
              <TableCell>
                <span className="font-medium">{request.method}</span><div className="text-muted-foreground max-w-md truncate text-xs">{request.prompt}</div>
                <RunOutputs mounts={mounts} result={request.outcome?.result as RunFiles | undefined} />
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">{formatTime(request.startedAt)}</TableCell>
              <TableCell>
                {request.state === "running" ? <Badge variant="live">running</Badge>
                  : request.outcome?.error ? <Badge variant={request.outcome.uncertain ? "outline" : "destructive"} title={request.outcome.error}>{request.outcome.uncertain ? "interrupted" : "failed"}</Badge>
                  : <Badge variant="outline">completed</Badge>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TryIt({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const [draft, setDraft] = useState("");
  const [attached, setAttached] = useState<File[]>([]);
  const [progress, setProgress] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try {
      // Attachments are uploaded first, under the request's id, then sent as {path} references.
      const requestId = crypto.randomUUID();
      const total = attached.reduce((sum, file) => sum + file.size, 0) || 1;
      let done = 0;
      const files: { path: string }[] = [];
      for (const file of attached) {
        setProgress(done / total);
        const saved = await putFile(`/v1/agents/${agentId}/uploads/${requestId}/${encodeURIComponent(file.name)}`, file, fraction => setProgress((done + fraction * file.size) / total));
        files.push({ path: saved.path });
        done += file.size;
      }
      setProgress(undefined);
      const request = await api<RequestRecord>(`/v1/agents/${agentId}/prompt`, { body: { text: draft, requestId, ...(files.length ? { files } : {}) } });
      setDraft(""); setAttached([]);
      for (let settled = request; settled.state === "running";) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        settled = await api<RequestRecord>(`/v1/agents/${agentId}/requests/${request.id}`);
        if (settled.state !== "running" && settled.outcome?.error) setError(settled.outcome.error);
        if (settled.state !== "running") break;
      }
      onDone();
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); setProgress(undefined); }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <p className="text-muted-foreground text-sm">
        Sends a prompt to this agent. If it calls one of your application's tools while your app is not connected, that call fails without running.
      </p>
      <ErrorAlert error={error} title="The prompt failed" />
      <Textarea rows={4} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Ask the agent something…" />
      {attached.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attached.map((file, index) => (
            <span key={index} className="bg-secondary text-secondary-foreground inline-flex h-6 items-center gap-1.5 px-2 text-xs">{file.name} · {formatBytes(file.size)}
              <button type="button" aria-label={`Remove ${file.name}`} disabled={busy} onClick={() => setAttached(attached.filter((_, at) => at !== index))}><X className="size-3" /></button>
            </span>
          ))}
        </div>
      )}
      {progress !== undefined && <Progress value={progress * 100} />}
      <input ref={input} type="file" multiple hidden onChange={event => { setAttached([...attached, ...event.target.files ?? []]); event.target.value = ""; }} />
      <div className="flex gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={() => input.current?.click()}><Paperclip />Attach</Button>
        <Button type="submit" disabled={!draft.trim() || busy}>{busy ? <Loader2 className="animate-spin" /> : <Send />}Send</Button>
      </div>
    </form>
  );
}

const SOURCE_KINDS: Record<ToolSource["kind"], string> = {
  channel: "Channel", application: "Your application", files: "File tools", builtin: "Built-in", mcp: "MCP server", openapi: "OpenAPI",
};

/**
 * Every source of the agent's tools and what each offers the model. Refresh lists MCP servers now
 * (a running agent takes changes at its next start); schemas fetch each tool's input schema.
 */
function ToolSources({ agentId, sources }: { agentId: string; sources: ToolSource[] }) {
  const [fetched, setFetched] = useState<{ sources: ToolSource[]; refreshed: boolean; at: number }>();
  const [busy, setBusy] = useState<"refresh" | "schemas">();
  const [error, setError] = useState<string>();
  // A fetched view (with schemas, or listed just now) stands for a minute, then the page's own polling takes over again.
  const shown = fetched && Date.now() - fetched.at < 60_000 ? fetched : undefined;
  async function load(kind: "refresh" | "schemas") {
    setBusy(kind); setError(undefined);
    try {
      const query = kind === "refresh" ? "schemas=true&refresh=true" : "schemas=true";
      const detail = await api<AgentDetail>(`/v1/agents/${agentId}?${query}`);
      setFetched({ sources: detail.toolSources, refreshed: kind === "refresh" || !!shown?.refreshed, at: Date.now() });
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(undefined); }
  }
  const list = shown?.sources ?? sources;
  const total = list.reduce((count, source) => count + source.tools.filter(tool => !tool.excluded).length, 0);
  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Tools the model gets ({total})</CardTitle>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void load("schemas")}>{busy === "schemas" ? <Loader2 className="animate-spin" /> : <Braces />}Schemas</Button>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void load("refresh")} title="List every MCP server now">{busy === "refresh" ? <Loader2 className="animate-spin" /> : <RefreshCw />}Refresh</Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ErrorAlert error={error} />
        {shown?.refreshed && <p className="text-muted-foreground text-xs">MCP servers were listed just now. A running agent takes their changes at its next start.</p>}
        {list.length === 0 && <p className="text-muted-foreground text-sm">No tools.</p>}
        {list.map(source => (
          <div key={`${source.kind}:${source.name}`} className="rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{SOURCE_KINDS[source.kind]}</span>
              {source.name !== source.kind && <span className="font-mono">{source.name}</span>}
              {source.status === "error" && <Badge variant="destructive">error</Badge>}
              {source.status === "unlisted" && <Badge variant="outline" title="This node has not listed this server yet; Refresh lists it now">not listed yet</Badge>}
              {source.connected !== undefined && <Badge variant={source.connected ? "secondary" : "outline"}>{source.connected ? "connected" : "not connected"}</Badge>}
              {source.url && <span className="text-muted-foreground truncate font-mono text-xs">{source.url}</span>}
              {source.listedAt && <span className="text-muted-foreground text-xs">listed {formatTime(source.listedAt)}</span>}
            </div>
            {source.error && <p className="text-destructive mt-1 text-xs break-all">{source.error}</p>}
            {source.tools.length === 0 && source.status === "listed" && <p className="text-muted-foreground mt-1 text-xs">No tools.</p>}
            <div className="mt-2 flex flex-col gap-2">
              {source.tools.map(tool => (
                <div key={tool.name} className={tool.excluded ? "opacity-60" : undefined}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm">{tool.name}</span>
                    {tool.exposure && <Badge variant="outline" title="direct: declared to the model; codemode: from js_exec; both">{tool.exposure}</Badge>}
                    {tool.excluded && <Badge variant="destructive" title={tool.excluded}>not offered</Badge>}
                  </div>
                  <div className="text-muted-foreground line-clamp-3 text-xs">{tool.excluded ? `${tool.excluded}. ` : ""}{tool.description}</div>
                  {tool.parameters && (
                    <details className="mt-1 text-xs"><summary className="text-muted-foreground cursor-pointer">Input schema</summary>
                      <pre className="bg-muted mt-1 max-h-60 overflow-auto p-2 font-mono">{JSON.stringify(tool.parameters, null, 2)}</pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** The agent's mounts, and a browser for each: the workspace first. */
function Files({ mounts = [] }: { mounts?: Mount[] }) {
  const sorted = [...mounts].sort((a, b) => Number(b.path === "/workspace") - Number(a.path === "/workspace"));
  if (!sorted.length) return <p className="text-muted-foreground text-sm">This agent has no mounts.</p>;
  return (
    <div className="flex flex-col gap-4">
      {sorted.map(mount => (
        <FileBrowser key={mount.path} volume={mount.volumeId} root={mount.subpath || "/"} title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-mono">{mount.path}</span>
            <Badge variant="outline">{mount.mode === "ro" ? "read-only" : "read-write"}</Badge>
            <Link to={`volumes/${mount.volumeId}`} className="text-muted-foreground font-mono text-xs font-normal underline">{mount.volumeId}</Link>
          </span>
        } />
      ))}
    </div>
  );
}

/**
 * Fork the agent: a new agent with its configuration, a copy of its conversation (through `atMessage`, else the last
 * finished turn) and of its files. The key is made once per dialog, so sending again returns the same fork.
 */
export function ForkDialog({ agent, atMessage, onClose }: { agent: AgentDetail; atMessage?: number; onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [key] = useState(() => `fork-${crypto.randomUUID()}`);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try {
      const forked = await api<{ id: string }>(`/v1/agents/${agent.id}/fork`, { body: { key, ...(name.trim() ? { name: name.trim() } : {}), ...(atMessage !== undefined ? { atMessage } : {}) } });
      onClose();
      navigate(`agents/${forked.id}`);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Fork {agent.name}</DialogTitle>
            <DialogDescription>
              A new agent with the same configuration, a copy of its files, and its conversation {atMessage !== undefined ? `through message ${atMessage}` : "through its last finished turn"}. From then on each goes its own way.
            </DialogDescription>
          </DialogHeader>
          <ErrorAlert error={error} />
          <div className="flex flex-col gap-2"><Label htmlFor="fork-name">Name (optional)</Label><Input id="fork-name" placeholder={`${agent.name} (fork)`} value={name} onChange={event => setName(event.target.value)} autoFocus /></div>
          <DialogFooter><Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <GitFork />}Fork</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AgentPage({ id }: { id: string }) {
  const agent = useApi<AgentDetail>(`/v1/agents/${id}`, 5_000);
  const history = useApi<{ messages: Message[] }>(`/v1/agents/${id}/history`, agent.data?.running ? 3_000 : undefined);
  const [error, setError] = useState<string>();
  /** The fork dialog, open: from the last finished turn, or from a message. */
  const [forking, setForking] = useState<{ atMessage?: number }>();
  if (agent.error?.status === 404) return <StatusPanel code="404" label="Not found" detail="This agent does not exist or belongs to another tenant."
    action={<Button variant="outline" asChild><Link to="agents"><ArrowLeft />Agents</Link></Button>} />;
  if (!agent.data) return <><ErrorAlert error={agent.error} /><Skeleton className="h-64 w-full" /></>;
  const data = agent.data;
  return (
    <>
      <Link to="agents" className="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"><ArrowLeft className="size-4" />Agents</Link>
      <PageHeader
        title={data.name}
        description={<span className="inline-flex flex-wrap items-center gap-2"><AgentStatus agent={data} /><span className="font-mono text-xs">{data.model}</span><span>· {data.type}</span>{data.definition && <Link to="definitions" className="underline">· definition revision {data.definition.revision}</Link>}{data.forkedFrom && <Link to={`agents/${data.forkedFrom.agentId}`} className="underline">· forked from {data.forkedFrom.agentId}{data.forkedFrom.atMessage !== null ? ` at message ${data.forkedFrom.atMessage}` : ""}</Link>}{data.parentAgentId && <Link to={`agents/${data.parentAgentId}`} className="underline">· sub-agent of {data.parentAgentId}</Link>}</span>}
        actions={<>
          <Button variant="outline" size="sm" onClick={() => setForking({})}><GitFork />Fork</Button>
          <ConfirmButton label="Abort" icon={<Square />} title="Abort the running turn?" description="The current model turn stops. Tool calls already started in your application may still complete." confirm="Abort"
            onConfirm={async () => { try { await api(`/v1/agents/${id}/abort`, { body: {} }); await agent.reload(); } catch (caught) { setError((caught as Error).message); } }} />
          <ConfirmButton label="Delete" icon={<Trash2 />} variant="destructive" title={`Delete ${data.name}?`} description="Its session token stops working and it disappears from your tenant. This cannot be undone." confirm="Delete agent"
            onConfirm={async () => { try { await api(`/v1/agents/${id}`, { method: "DELETE" }); navigate("agents"); } catch (caught) { setError((caught as Error).message); } }} />
        </>}
      />
      <ErrorAlert error={error} />
      {forking && <ForkDialog agent={data} atMessage={forking.atMessage} onClose={() => setForking(undefined)} />}
      <Tabs defaultValue="conversation">
        <TabsList>
          <TabsTrigger value="conversation">Conversation</TabsTrigger>
          <TabsTrigger value="requests">Requests</TabsTrigger>
          <TabsTrigger value="try">Try it</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="config">Configuration</TabsTrigger>
        </TabsList>
        <TabsContent value="conversation" className="pt-4"><ErrorAlert error={history.error} />{history.data ? <Conversation messages={history.data.messages} mounts={data.mounts} onFork={atMessage => setForking({ atMessage })} /> : <Skeleton className="h-40 w-full" />}</TabsContent>
        <TabsContent value="requests" className="pt-4"><Requests requests={data.requests} mounts={data.mounts} /></TabsContent>
        <TabsContent value="try" className="pt-4"><TryIt agentId={id} onDone={() => { void history.reload(); void agent.reload(); }} /></TabsContent>
        <TabsContent value="files" className="pt-4"><Files mounts={data.mounts} /></TabsContent>
        <TabsContent value="config" className="grid gap-4 pt-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>System prompt</CardTitle></CardHeader>
            <CardContent><pre className="max-h-96 overflow-auto text-sm whitespace-pre-wrap">{data.systemPrompt || "(runtime default)"}</pre></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Agent ID</CardTitle></CardHeader>
            <CardContent><div className="text-muted-foreground flex items-center gap-1 font-mono text-xs">{id}<CopyButton value={id} label="Copy agent ID" /></div></CardContent>
          </Card>
          <ToolSources agentId={id} sources={data.toolSources ?? []} />
        </TabsContent>
      </Tabs>
    </>
  );
}
