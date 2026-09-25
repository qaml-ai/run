import { useState, type FormEvent } from "react";
import { ArrowLeft, Braces, Loader2, RefreshCw, Send, Square, Trash2, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmButton, CopyButton, EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatTime, useApi, type AgentDetail, type RequestRecord, type ToolSource } from "@/lib/api";
import { Link, navigate } from "@/lib/router";
import { AgentStatus } from "@/pages/agents";

type Part = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown; id?: string };
type Message = { role: string; content: string | Part[]; toolName?: string; isError?: boolean; timestamp?: number; stopReason?: string; errorMessage?: string };
const parts = (content: Message["content"]): Part[] => typeof content === "string" ? [{ type: "text", text: content }] : content ?? [];
const text = (content: Message["content"]) => parts(content).filter(part => part.type === "text").map(part => part.text).join("\n");

function Conversation({ messages }: { messages: Message[] }) {
  if (!messages.length) return <EmptyState icon={<Send />} title="No messages yet">Prompts sent by your app, or from the “Try it” tab, appear here.</EmptyState>;
  return (
    <div className="flex flex-col gap-3">
      {messages.map((message, index) => {
        if (message.role === "user") return (
          <div key={index} className="bg-muted ml-auto max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">{text(message.content) || "(image)"}</div>
        );
        if (message.role === "toolResult") return (
          <details key={index} className="rounded-md border px-3 py-2 text-xs">
            <summary className="text-muted-foreground cursor-pointer">
              Result of <span className="font-mono">{message.toolName}</span>{message.isError && <Badge variant="destructive" className="ml-2">error</Badge>}
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto font-mono whitespace-pre-wrap">{text(message.content)}</pre>
          </details>
        );
        return (
          <div key={index} className="flex max-w-[85%] flex-col gap-2 text-sm">
            {parts(message.content).map((part, partIndex) => part.type === "text" ? <p key={partIndex} className="whitespace-pre-wrap">{part.text}</p>
              : part.type === "thinking" ? <p key={partIndex} className="text-muted-foreground text-xs italic whitespace-pre-wrap">{part.thinking}</p>
              : part.type === "toolCall" ? (
                <div key={partIndex} className="bg-muted/50 flex items-start gap-2 rounded-md border px-3 py-2 font-mono text-xs">
                  <Wrench className="mt-0.5 size-3.5 shrink-0" />
                  <span className="break-all">{part.name}({JSON.stringify(part.arguments)})</span>
                </div>
              ) : null)}
            {message.stopReason === "error" && <ErrorAlert error={message.errorMessage ?? "The model call failed"} title="Model error" />}
          </div>
        );
      })}
    </div>
  );
}

function Requests({ requests }: { requests: RequestRecord[] }) {
  if (!requests.length) return <p className="text-muted-foreground text-sm">No requests recorded since this agent was last loaded.</p>;
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader><TableRow><TableHead>Request</TableHead><TableHead>Started</TableHead><TableHead>Outcome</TableHead></TableRow></TableHeader>
        <TableBody>
          {[...requests].reverse().map(request => (
            <TableRow key={request.id}>
              <TableCell><span className="font-medium">{request.method}</span><div className="text-muted-foreground max-w-md truncate text-xs">{request.prompt}</div></TableCell>
              <TableCell className="text-muted-foreground text-xs">{formatTime(request.startedAt)}</TableCell>
              <TableCell>
                {request.state === "running" ? <Badge variant="secondary"><Loader2 className="animate-spin" />running</Badge>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try {
      const request = await api<RequestRecord>(`/v1/agents/${agentId}/prompt`, { body: { text: draft } });
      setDraft("");
      for (let settled = request; settled.state === "running";) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        settled = await api<RequestRecord>(`/v1/agents/${agentId}/requests/${request.id}`);
        if (settled.state !== "running" && settled.outcome?.error) setError(settled.outcome.error);
        if (settled.state !== "running") break;
      }
      onDone();
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <p className="text-muted-foreground text-sm">
        Sends a prompt to this agent. If it calls one of your application's tools while your app is not connected, that call fails without running.
      </p>
      <ErrorAlert error={error} title="The prompt failed" />
      <Textarea rows={4} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Ask the agent something…" />
      <div><Button type="submit" disabled={!draft.trim() || busy}>{busy ? <Loader2 className="animate-spin" /> : <Send />}Send</Button></div>
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
                      <pre className="bg-muted/50 mt-1 max-h-60 overflow-auto rounded p-2 font-mono">{JSON.stringify(tool.parameters, null, 2)}</pre>
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

export function AgentPage({ id }: { id: string }) {
  const agent = useApi<AgentDetail>(`/v1/agents/${id}`, 5_000);
  const history = useApi<{ messages: Message[] }>(`/v1/agents/${id}/history`, agent.data?.running ? 3_000 : undefined);
  const [error, setError] = useState<string>();
  if (agent.error?.status === 404) return <ErrorAlert error="This agent does not exist or belongs to another tenant." />;
  if (!agent.data) return <><ErrorAlert error={agent.error} /><Skeleton className="h-64 w-full" /></>;
  const data = agent.data;
  return (
    <>
      <Link to="agents" className="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"><ArrowLeft className="size-4" />Agents</Link>
      <PageHeader
        title={data.name}
        description={<span className="inline-flex flex-wrap items-center gap-2"><AgentStatus agent={data} /><span className="font-mono text-xs">{data.model}</span><span>· {data.type}</span>{data.definition && <Link to="definitions" className="underline">· definition revision {data.definition.revision}</Link>}</span>}
        actions={<>
          <ConfirmButton label="Abort" icon={<Square />} title="Abort the running turn?" description="The current model turn stops. Tool calls already started in your application may still complete." confirm="Abort"
            onConfirm={async () => { try { await api(`/v1/agents/${id}/abort`, { body: {} }); await agent.reload(); } catch (caught) { setError((caught as Error).message); } }} />
          <ConfirmButton label="Delete" icon={<Trash2 />} variant="destructive" title={`Delete ${data.name}?`} description="Its session token stops working and it disappears from your tenant. This cannot be undone." confirm="Delete agent"
            onConfirm={async () => { try { await api(`/v1/agents/${id}`, { method: "DELETE" }); navigate("agents"); } catch (caught) { setError((caught as Error).message); } }} />
        </>}
      />
      <ErrorAlert error={error} />
      <Tabs defaultValue="conversation">
        <TabsList>
          <TabsTrigger value="conversation">Conversation</TabsTrigger>
          <TabsTrigger value="requests">Requests</TabsTrigger>
          <TabsTrigger value="try">Try it</TabsTrigger>
          <TabsTrigger value="config">Configuration</TabsTrigger>
        </TabsList>
        <TabsContent value="conversation" className="pt-4"><ErrorAlert error={history.error} />{history.data ? <Conversation messages={history.data.messages} /> : <Skeleton className="h-40 w-full" />}</TabsContent>
        <TabsContent value="requests" className="pt-4"><Requests requests={data.requests} /></TabsContent>
        <TabsContent value="try" className="pt-4"><TryIt agentId={id} onDone={() => { void history.reload(); void agent.reload(); }} /></TabsContent>
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
