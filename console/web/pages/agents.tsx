import { useAgentPreviews } from "@/lib/agent-previews";
import { type InboxPage } from "@/lib/inbox";
import { useEffect, useState } from "react";
import { Bot, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { MoveMenu, ScopeCrumb, scopeName, WorkspaceTag } from "@/components/workspace-ui";
import { AGENT_PAGE, formatAgo, formatTime, useApiPage, useApi, type AgentSummary, type Billing } from "@/lib/api";
import { docsUrl } from "@/lib/docs";
import { Link, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { moveToWorkspace, UNASSIGNED, useWorkspace, useWorkspaceDirectory } from "@/lib/workspace";

/** A run failed in the last day: what GET /v1/agents' status=failed selects. */
const FAILED_WINDOW_MS = 24 * 3600_000;
const failedRecently = (agent: Pick<AgentSummary, "lastError">, now = Date.now()) => !!agent.lastError && now - agent.lastError.at < FAILED_WINDOW_MS;

export function AgentStatus({ agent }: { agent: Pick<AgentSummary, "running" | "connected" | "lastError"> }) {
  if (agent.running) return <Badge variant="live">Running</Badge>;
  // The class only (model_error, spend_limit…); the run's message is on its Requests tab.
  if (failedRecently(agent)) return <Badge variant="destructive" title={`Latest failed run: ${agent.lastError!.class.replace(/_/g, " ")}, ${formatTime(agent.lastError!.at)}`}>Failed</Badge>;
  if (agent.connected) return <Badge variant="secondary">Connected</Badge>;
  return <Badge variant="outline" className="text-muted-foreground">Asleep</Badge>;
}

/** Agents in order, each sub-agent right under its parent, with how deep it sits; one whose parent is gone is listed on its own. */
export function nested(agents: AgentSummary[]): { agent: AgentSummary; depth: number }[] {
  const ids = new Set(agents.map(agent => agent.id));
  const children = new Map<string, AgentSummary[]>();
  for (const agent of agents) if (agent.parentAgentId && ids.has(agent.parentAgentId)) children.set(agent.parentAgentId, [...children.get(agent.parentAgentId) ?? [], agent]);
  const rows: { agent: AgentSummary; depth: number }[] = [];
  const visit = (agent: AgentSummary, depth: number) => {
    rows.push({ agent, depth });
    for (const child of children.get(agent.id) ?? []) visit(child, depth + 1);
  };
  for (const agent of agents) if (!agent.parentAgentId || !ids.has(agent.parentAgentId)) visit(agent, 0);
  return rows;
}

/** The list's filters, each one of GET /v1/agents' (the server filters and pages). */
const FILTERS = {
  all: { label: "All", query: {} },
  running: { label: "Running", query: { status: "running" } },
  failed: { label: "Failed · 24h", query: { status: "failed" } },
  sub: { label: "Sub-agents", query: { subAgents: "only" } },
  expiring: { label: "Expiring", query: { status: "expiring" } },
} as const;
type Filter = keyof typeof FILTERS;

/** The GET /v1/agents path for a page of the list. */
export function agentsPath({ ws, filter, q, cursor, limit = AGENT_PAGE }: { ws?: string; filter: Filter; q: string; cursor?: string; limit?: number }) {
  const params = new URLSearchParams({ limit: String(limit), ...FILTERS[filter].query });
  if (ws) params.set("workspaceId", ws);
  if (q.trim()) params.set("q", q.trim());
  if (cursor) params.set("cursor", cursor);
  return `/v1/agents?${params}`;
}

/** `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms = 300) {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setSettled(value), ms); return () => clearTimeout(timer); }, [value, ms]);
  return settled;
}

export function AgentsPage({ hasAgents, billing }: {
  /** Whether the account has any agent at all (an empty page of a filter does not say). */
  hasAgents: boolean | undefined;
  billing: ReturnType<typeof useApi<Billing>>;
}) {
  const { ws, setWorkspace } = useWorkspace();
  const directory = useWorkspaceDirectory();
  const [query, setQuery] = useState("");
  const q = useSettled(query);
  const [filter, setFilter] = useState<Filter>("all");
  // The cursors of the pages before this one, and this one's.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<unknown>();
  // Single-project accounts stay as simple as before: no workspace column, no selection.
  const grouped = !!directory.workspaces?.length;
  const scope = grouped ? ws : undefined;
  // Back to the first page whenever what is listed changes.
  useEffect(() => { setCursors([undefined]); setSelected(new Set()); }, [scope, filter, q]);
  // Only the page in view is polled, never the whole list.
  const page = useApiPage<AgentSummary>(hasAgents ? agentsPath({ ws: scope, filter, q, cursor: cursors.at(-1) }) : undefined, 10_000);
  const shown = page.items ?? page.previous ?? [];
  const rows = nested(shown);
  const previews = useAgentPreviews(shown);
  const inbox = useApi<InboxPage>("/v1/inbox?limit=1", 15_000);
  const picked = shown.filter(agent => selected.has(agent.id));
  const toggle = (id: string, on: boolean) => setSelected(current => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });
  const move = async (ids: string[], workspaceId: string | null) => {
    setMoving(true); setError(undefined);
    try { await moveToWorkspace("agent", ids, workspaceId); setSelected(new Set()); await page.reload(); }
    catch (caught) { setError(caught); }
    finally { setMoving(false); }
  };
  const name = scopeName(directory, ws);
  const showWorkspace = grouped && scope === undefined;
  const filtered = !!q.trim() || filter !== "all";

  return (
    <>
      <ScopeCrumb directory={directory} />
      <PageHeader
        title="Agents"
        description="Your conversations. Pick an agent to keep working together." docs="concepts"
        actions={<>
          {hasAgents && <div className="relative">
            <Search aria-hidden="true" className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
            <Input type="search" aria-label="Search agents" placeholder="Search name, key or id" className="w-56 pl-7" value={query} onChange={event => setQuery(event.target.value)} />
          </div>}
          <Button variant="outline" size="sm" onClick={() => void page.reload()}><RefreshCw />Refresh</Button>
        </>}
      />
      <ErrorAlert error={(error as Error | undefined) ?? page.error ?? (grouped ? directory.error : undefined)} />
      <ErrorAlert error={hasAgents === false ? billing.error : undefined} />
      {hasAgents === undefined ? <Skeleton className="h-40 w-full" />
        : !hasAgents ? (
          <EmptyState icon={<Bot />} title="No agents yet"
            action={<><Button size="sm" asChild><Link to="start">Get started</Link></Button><Button size="sm" variant="outline" asChild><a href={docsUrl("concepts")} target="_blank" rel="noreferrer">How agents work</a></Button></>}>
            An agent is a durable conversation with a model: its history, files and tools stay with it between runs. Try one in Get started, or make one from your code.
          </EmptyState>
        ) : (
          <>
            <div role="group" aria-label="Filter agents" className="mb-3 flex flex-wrap gap-2">
              {(Object.keys(FILTERS) as Filter[]).map(key => (
                <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={cn(
                  "focus-visible:ring-ring border px-2.5 py-1 text-xs outline-none focus-visible:ring-2",
                  filter === key ? "bg-foreground text-background border-foreground" : "bg-background hover:bg-accent",
                )}>{FILTERS[key].label}</button>
              ))}
            </div>
            {grouped && picked.length > 0 && (
              <div className="bg-accent mb-1.5 flex flex-wrap items-center gap-3 border px-3 py-2" role="region" aria-label="Selected agents">
                <span className="text-sm font-medium">{picked.length} selected</span>
                <MoveMenu directory={directory} onMove={workspaceId => void move(picked.map(agent => agent.id), workspaceId)}>
                  <Button size="sm" variant="outline" disabled={moving}>Move to workspace<ChevronDown /></Button>
                </MoveMenu>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>Clear</Button>
              </div>
            )}
            {!page.items && !page.previous ? <Skeleton className="h-40 w-full" /> : rows.length === 0 && cursors.length === 1 ? (
              <EmptyState icon={<Bot />} title={filtered ? "No agents match" : ws === UNASSIGNED ? "Every agent is in a workspace" : `No agents in ${name ?? "this workspace"} yet`}
                action={filtered ? <Button size="sm" variant="outline" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</Button>
                  : <Button size="sm" variant="outline" onClick={() => setWorkspace(undefined)}>Show all workspaces</Button>}>
                {filtered ? "Nothing here matches the search and filter." : ws === UNASSIGNED ? "Agents in no workspace show here." : "Move agents here from All workspaces, or create them with this workspace's workspaceId."}
              </EmptyState>
            ) : (
              <div className={cn("grid gap-3 transition-opacity", page.stale && "opacity-60")} aria-busy={page.stale}>
                {rows.map(({ agent, depth }) => <div key={agent.id} className="flex flex-wrap items-center gap-3" style={depth ? { marginLeft: `${Math.min(depth, 3)}rem` } : undefined}>
                  {grouped && <input type="checkbox" aria-label={`Select ${agent.name}`} checked={selected.has(agent.id)} onChange={event => toggle(agent.id, event.target.checked)} />}
                  <AgentPreview agent={agent} preview={previews[agent.id]} pending={inbox.data?.counts?.lead[agent.id] ?? 0} />
                  {showWorkspace && (agent.workspaceId ? <WorkspaceTag directory={directory} id={agent.workspaceId} /> : <MoveMenu directory={directory} current={null} label="Assign to workspace" onMove={target => void move([agent.id], target)}><button type="button" className="text-xs underline" disabled={moving}>Assign…</button></MoveMenu>)}
                </div>)}
              </div>
            )}
            {(cursors.length > 1 || page.next) && (
              <nav aria-label="Pages" className="mt-3 flex items-center justify-end gap-2 text-sm">
                <span className="text-muted-foreground mr-2">Page {cursors.length}</span>
                <Button size="sm" variant="outline" disabled={cursors.length === 1} onClick={() => { setCursors(current => current.slice(0, -1)); setSelected(new Set()); }}><ChevronLeft />Previous</Button>
                <Button size="sm" variant="outline" disabled={!page.next || page.stale} onClick={() => { setCursors(current => [...current, page.next]); setSelected(new Set()); }}>Next<ChevronRight /></Button>
              </nav>
            )}
          </>
        )}
    </>
  );
}

export function AgentPreview({ agent, preview, pending = 0 }: { agent: AgentSummary; preview?: string; pending?: number }) {
  const status = pending ? "Waiting on you" : agent.running ? "Working" : failedRecently(agent) ? "Error" : "Idle";
  return <Link aria-label={agent.name} to={`agents/${agent.id}`} className="min-w-0 flex-1 rounded-xl border bg-card p-4 transition-colors hover:bg-accent focus-visible:ring-2">
    <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{agent.name}</span><Badge variant={pending ? "secondary" : agent.running ? "live" : status === "Error" ? "destructive" : "outline"}>{status}</Badge>{pending > 0 && <Badge variant="secondary">{pending} pending</Badge>}<span className="ml-auto text-xs text-muted-foreground">{agent.running ? "now" : formatAgo(agent.lastActiveAt)}</span></div>
    <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{preview === undefined ? "Loading conversation…" : preview || "Start a conversation"}</p>
  </Link>;
}
