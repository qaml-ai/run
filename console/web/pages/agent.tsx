import { useState, type FormEvent } from "react";
import { ArrowLeft, Eraser, FolderPlus, GitFork, Loader2, Minimize2, Save, Square, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusPanel } from "@/components/brand";
import { ConfirmButton, CopyButton, ErrorAlert } from "@/components/common";
import { RepoBrowser } from "@/components/repo-browser";
import {
  api,
  formatCost,
  formatNumber,
  formatTime,
  useApi,
  type AgentDetail,
  type Model,
  type RunRecord,
} from "@/lib/api";
import { Link, navigate } from "@/lib/router";
import { ConsoleAgentChat } from "./agent-chat";
import { AgentSchedules } from "./agent-schedules";

function RunsTable({ agentId }: { agentId: string }) {
  const state = useApi<{ cursor: number; activeRunId: string | null; runs: RunRecord[] }>(
    `/v2/agents/${encodeURIComponent(agentId)}/runs`,
    5_000,
  );
  if (state.error) return <ErrorAlert error={state.error} />;
  if (!state.data) return <Skeleton className="h-32 w-full" />;
  const runs = [...state.data.runs].reverse();
  if (!runs.length) return <p className="text-muted-foreground text-sm">No runs recorded for this agent yet.</p>;
  return (
    <div className="bg-card border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
            <TableHead>Started</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map(run => (
            <TableRow key={run.id}>
              <TableCell>
                <div className="font-mono text-xs">{run.id}</div>
                {run.text && <div className="text-muted-foreground max-w-md truncate text-xs">{run.text}</div>}
                {run.error && <div className="text-destructive max-w-md truncate text-xs">{run.error.code}: {run.error.message}</div>}
                {run.toolCalls.length > 0 && (
                  <div className="text-muted-foreground text-xs">{run.toolCalls.length} tool call{run.toolCalls.length === 1 ? "" : "s"}</div>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">{formatTime(run.startedAt)}</TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums">
                {formatNumber((run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0))}
              </TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums">
                {formatCost(run.usage?.costUsd ?? 0)}
              </TableCell>
              <TableCell>
                {run.status === "running" ? <Badge variant="live">running</Badge>
                  : run.status === "queued" ? <Badge variant="secondary">queued</Badge>
                  : run.status === "input_required" ? <Badge variant="info">input required</Badge>
                  : run.status === "failed" ? <Badge variant="destructive">failed</Badge>
                  : run.status === "cancelled" ? <Badge variant="outline">cancelled</Badge>
                  : <Badge variant="outline">completed</Badge>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function AgentFiles({ agent, onRepoReady }: { agent: AgentDetail; onRepoReady: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function initRepo() {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/v2/agents/${encodeURIComponent(agent.id)}/repo`, { method: "PUT", body: {} });
      onRepoReady();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!agent.repoId) {
    return (
      <div className="flex flex-col items-start gap-3 border border-dashed p-6">
        <ErrorAlert error={error} />
        <p className="text-muted-foreground text-sm">
          This agent does not have a CamelFS repository attached yet. Initialize one to store, edit, and version workspace files.
        </p>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void initRepo()}>
          {busy ? <Loader2 className="animate-spin" /> : <FolderPlus />}Initialize repository
        </Button>
      </div>
    );
  }

  return (
    <RepoBrowser
      repoId={agent.repoId}
      refName={agent.branch || "refs/heads/main"}
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="font-mono">/workspace</span>
          <Badge variant="outline">{agent.branch || "refs/heads/main"}</Badge>
          <Link to={`repos/${agent.repoId}`} className="text-muted-foreground font-mono text-xs font-normal underline">
            {agent.repoId}
          </Link>
        </span>
      }
    />
  );
}

export function ForkDialog({ agent, onClose }: { agent: AgentDetail; onClose: () => void }) {
  const [key, setKey] = useState(`${agent.key}-fork-${Math.random().toString(36).slice(2, 6)}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const forked = await api<{ id: string }>(`/v2/agents/${encodeURIComponent(agent.id)}/fork`, {
        method: "POST",
        body: { ...(key.trim() ? { key: key.trim() } : {}) },
      });
      onClose();
      navigate(`agents/${forked.id}`);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Fork {agent.key}</DialogTitle>
            <DialogDescription>
              Creates a new durable agent with the same configuration, conversation history, and a copy-on-write fork of its repository.
            </DialogDescription>
          </DialogHeader>
          <ErrorAlert error={error} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="fork-key">New agent key</Label>
            <Input
              id="fork-key"
              className="font-mono text-xs"
              value={key}
              onChange={event => setKey(event.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <GitFork />}Fork
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConfigTab({ agent, onUpdated }: { agent: AgentDetail; onUpdated: () => void }) {
  const models = useApi<Model[]>("/v2/models");
  const [model, setModel] = useState(agent.model);
  const [spendLimit, setSpendLimit] = useState(String(agent.spendLimitUsd));
  const [busy, setBusy] = useState<"model" | "spend">();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function saveModel(event: FormEvent) {
    event.preventDefault();
    if (!model.trim() || model.trim() === agent.model) return;
    setBusy("model");
    setError(undefined);
    setNotice(undefined);
    try {
      await api(`/v2/agents/${encodeURIComponent(agent.id)}/model`, {
        method: "PATCH",
        body: { model: model.trim(), expectedModel: agent.model },
      });
      setNotice(`Model updated to ${model.trim()}.`);
      onUpdated();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function saveSpendLimit(event: FormEvent) {
    event.preventDefault();
    const next = Number(spendLimit);
    if (!Number.isFinite(next) || next < 0) return;
    setBusy("spend");
    setError(undefined);
    setNotice(undefined);
    try {
      await api(`/v2/agents/${encodeURIComponent(agent.id)}/spend-limit`, {
        method: "PATCH",
        body: { spendLimitUsd: next, expectedSpendLimitUsd: agent.spendLimitUsd },
      });
      setNotice(`Spend limit updated to $${next.toFixed(2)}.`);
      onUpdated();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {(error || notice) && (
        <div className="lg:col-span-2">
          <ErrorAlert error={error} />
          {notice && <p role="status" className="bg-muted border px-3 py-2 text-xs">{notice}</p>}
        </div>
      )}
      <Card>
        <CardHeader><CardTitle>System instructions</CardTitle></CardHeader>
        <CardContent>
          <pre className="max-h-72 overflow-auto text-sm whitespace-pre-wrap">{agent.instructions || "(runtime default)"}</pre>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Identity &amp; limits</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Agent ID</span>
            <span className="inline-flex items-center gap-1 font-mono">{agent.id}<CopyButton value={agent.id} label="Copy agent ID" /></span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Key</span>
            <span className="font-mono">{agent.key}</span>
          </div>
          {agent.definition && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Definition</span>
              <span className="font-mono">{agent.definition}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Messages</span>
            <span className="font-mono">{agent.messageCount}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Queue mode</span>
            <span className="font-mono">{agent.queue.mode}{agent.queue.windowMs ? ` (${agent.queue.windowMs}ms)` : ""}</span>
          </div>
          <form onSubmit={saveModel} className="mt-2 flex items-end gap-2 border-t pt-3">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="cfg-model">Model (when idle)</Label>
              <Input
                id="cfg-model"
                list="cfg-model-options"
                className="font-mono text-xs"
                value={model}
                onChange={event => setModel(event.target.value)}
              />
              <datalist id="cfg-model-options">
                {models.data?.map(m => <option key={m.id} value={m.id} />)}
              </datalist>
            </div>
            <Button size="sm" variant="outline" type="submit" disabled={busy === "model" || !model.trim() || model.trim() === agent.model}>
              {busy === "model" ? <Loader2 className="animate-spin" /> : <Save />}Save
            </Button>
          </form>
          <form onSubmit={saveSpendLimit} className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="cfg-spend">Spend limit (USD)</Label>
              <Input
                id="cfg-spend"
                type="number"
                min="0"
                step="0.01"
                className="font-mono text-xs"
                value={spendLimit}
                onChange={event => setSpendLimit(event.target.value)}
              />
            </div>
            <Button size="sm" variant="outline" type="submit" disabled={busy === "spend" || Number(spendLimit) === agent.spendLimitUsd}>
              {busy === "spend" ? <Loader2 className="animate-spin" /> : <Save />}Save
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>Tools &amp; MCP servers</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 text-xs">
          <div>
            <span className="text-muted-foreground">Built-in suites: </span>
            {agent.builtins.length ? (
              <span className="inline-flex flex-wrap gap-1">
                {agent.builtins.map(b => <Badge key={b} variant="outline">{b}</Badge>)}
              </span>
            ) : <span className="text-muted-foreground">none</span>}
          </div>
          {agent.tools.length > 0 && (
            <div>
              <p className="mb-1 font-medium">Custom tools ({agent.tools.length})</p>
              <ul className="space-y-1">
                {agent.tools.map(t => (
                  <li key={t.name} className="border p-2">
                    <span className="font-mono font-medium">{t.name}</span>
                    {t.requiresApproval && <Badge variant="outline" className="ml-2">approval</Badge>}
                    {t.description && <p className="text-muted-foreground mt-0.5">{t.description}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {agent.mcpServers.length > 0 && (
            <div>
              <p className="mb-1 font-medium">MCP servers ({agent.mcpServers.length})</p>
              <ul className="space-y-1">
                {agent.mcpServers.map(s => (
                  <li key={s.name} className="border p-2">
                    <span className="font-mono font-medium">{s.name}</span>
                    <span className="text-muted-foreground ml-2 font-mono">{s.url}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function AgentPage({ id }: { id: string }) {
  const agent = useApi<AgentDetail>(`/v2/agents/${encodeURIComponent(id)}`);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [manage, setManage] = useState(false);
  const [forking, setForking] = useState(false);
  const [chatEpoch, setChatEpoch] = useState(0);

  if (agent.error?.status === 404) {
    return (
      <StatusPanel
        code="404"
        label="Not found"
        detail="This agent does not exist or belongs to another tenant."
        action={<Button variant="outline" asChild><Link to="agents"><ArrowLeft />Agents</Link></Button>}
      />
    );
  }
  if (!agent.data) return <><ErrorAlert error={agent.error} /><Skeleton className="h-64 w-full" /></>;

  const data = agent.data;

  return (
    <>
      <header className="mb-3 flex min-w-0 items-center gap-3">
        <Link to="agents" aria-label="Back to agents" className="shrink-0 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-lg font-semibold">{data.key}</h1>
            <Badge variant={data.status === "running" ? "live" : "outline"}>
              {data.status === "running" ? "Running" : "Idle"}
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-xs text-muted-foreground">{data.model}</span>
            <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={() => setManage(true)}>
              Manage agent
            </Button>
          </div>
        </div>
      </header>
      <ErrorAlert error={error} />
      {notice && <p role="status" className="bg-muted mb-3 border px-3 py-2 text-xs">{notice}</p>}
      {forking && <ForkDialog agent={data} onClose={() => setForking(false)} />}

      <ConsoleAgentChat
        key={`${id}:${chatEpoch}`}
        agentId={id}
        repoId={data.repoId}
        branch={data.branch}
        instructions={data.instructions}
        onAgentChanged={() => void agent.reload()}
      />

      <Dialog open={manage} onOpenChange={setManage}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Manage {data.key}</DialogTitle>
            <DialogDescription>Runs, repository files, schedules, configuration, and lifecycle controls.</DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground font-mono">
            {data.id}
            {data.definition ? ` · definition ${data.definition}` : ""}
            {data.repoId ? ` · repo ${data.repoId}` : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setForking(true)}>
              <GitFork />Fork
            </Button>
            <ConfirmButton
              label="Compact"
              icon={<Minimize2 />}
              title="Compact conversation history?"
              description="Summarizes older messages into a compaction checkpoint to reduce context size."
              confirm="Compact"
              onConfirm={async () => {
                try {
                  setError(undefined);
                  const res = await api<{ compactedCount: number }>(`/v2/agents/${encodeURIComponent(id)}/compact`, {
                    method: "POST",
                    body: {},
                  });
                  setNotice(`Compacted ${res.compactedCount} message${res.compactedCount === 1 ? "" : "s"}.`);
                  setChatEpoch(n => n + 1);
                  await agent.reload();
                } catch (caught) {
                  setError((caught as Error).message);
                }
              }}
            />
            <ConfirmButton
              label="Reset context"
              icon={<Eraser />}
              title="Reset conversation context?"
              description="Clears all stored messages and compactions for this agent. Its repository files remain untouched."
              confirm="Reset context"
              onConfirm={async () => {
                try {
                  setError(undefined);
                  await api(`/v2/agents/${encodeURIComponent(id)}/reset-context`, { method: "POST", body: { keepLast: 0 } });
                  setNotice("Conversation context reset.");
                  setChatEpoch(n => n + 1);
                  await agent.reload();
                } catch (caught) {
                  setError((caught as Error).message);
                }
              }}
            />
            <ConfirmButton
              label="Abort"
              icon={<Square />}
              title="Abort the running turn?"
              description="Stops the active run and cancels queued runs."
              confirm="Abort"
              onConfirm={async () => {
                try {
                  setError(undefined);
                  await api(`/v2/agents/${encodeURIComponent(id)}/abort`, { method: "POST", body: {} });
                  await agent.reload();
                } catch (caught) {
                  setError((caught as Error).message);
                }
              }}
            />
            <ConfirmButton
              label="Delete"
              icon={<Trash2 />}
              variant="destructive"
              title={`Delete ${data.key}?`}
              description="Destroys this agent's Durable Object state and removes it from your tenant. This cannot be undone."
              confirm="Delete agent"
              onConfirm={async () => {
                try {
                  await api(`/v2/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
                  navigate("agents");
                } catch (caught) {
                  setError((caught as Error).message);
                }
              }}
            />
          </div>
          <Tabs defaultValue="runs">
            <TabsList variant="line" className="max-w-full overflow-x-auto">
              <TabsTrigger value="runs">Runs</TabsTrigger>
              <TabsTrigger value="files">Files</TabsTrigger>
              <TabsTrigger value="config">Configuration</TabsTrigger>
              <TabsTrigger value="schedules">Schedules</TabsTrigger>
            </TabsList>
            <TabsContent value="runs" className="pt-4"><RunsTable agentId={id} /></TabsContent>
            <TabsContent value="files" className="pt-4"><AgentFiles agent={data} onRepoReady={() => void agent.reload()} /></TabsContent>
            <TabsContent value="config" className="pt-4"><ConfigTab agent={data} onUpdated={() => void agent.reload()} /></TabsContent>
            <TabsContent value="schedules" className="pt-4"><AgentSchedules agentId={id} /></TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </>
  );
}
