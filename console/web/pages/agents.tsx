import { useEffect, useState } from "react";
import { Bot, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { MoveMenu, ScopeCrumb, scopeName, WorkspaceTag } from "@/components/workspace-ui";
import { AGENT_PAGE, formatAgo, formatTime, useApiPage, type useApi, type AgentSummary, type Billing } from "@/lib/api";
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
        description="Agents in your account. Your application creates them with the SDK or POST /v1/agents." docs="concepts"
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
              <div className={cn("bg-card border transition-opacity", page.stale && "opacity-60")} aria-busy={page.stale}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      {grouped && <TableHead className="w-8"><input type="checkbox" aria-label="Select all agents on this page" className="accent-foreground size-4 align-middle"
                        checked={shown.length > 0 && picked.length === shown.length} ref={element => { if (element) element.indeterminate = picked.length > 0 && picked.length < shown.length; }}
                        onChange={event => setSelected(event.target.checked ? new Set(shown.map(agent => agent.id)) : new Set())} /></TableHead>}
                      <TableHead>Name</TableHead>
                      {showWorkspace && <TableHead>Workspace</TableHead>}
                      <TableHead>Model</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden md:table-cell">Last active</TableHead>
                      <TableHead className="hidden lg:table-cell">Session expires</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map(({ agent, depth }) => (
                      <TableRow key={agent.id} className="cursor-pointer" data-state={selected.has(agent.id) ? "selected" : undefined} onClick={() => navigate(`agents/${agent.id}`)}>
                        {grouped && <TableCell onClick={event => event.stopPropagation()}>
                          <input type="checkbox" aria-label={`Select ${agent.name}`} className="accent-foreground size-4 align-middle" checked={selected.has(agent.id)} onChange={event => toggle(agent.id, event.target.checked)} />
                        </TableCell>}
                        <TableCell style={depth ? { paddingLeft: `${0.5 + depth * 1.25}rem` } : undefined}>
                          {depth > 0 && <span className="text-muted-foreground mr-1" aria-label="sub-agent of the row above">↳</span>}<Link className="font-medium" to={`agents/${agent.id}`}>{agent.name}</Link>
                          {agent.key && depth === 0 && <div className="text-muted-foreground font-mono text-xs">key {agent.key}</div>}
                        </TableCell>
                        {showWorkspace && <TableCell onClick={event => event.stopPropagation()}>
                          {agent.workspaceId ? <WorkspaceTag directory={directory} id={agent.workspaceId} /> : (
                            <MoveMenu directory={directory} current={null} label="Assign to workspace" onMove={target => void move([agent.id], target)}>
                              <button type="button" className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4" disabled={moving}>Assign…</button>
                            </MoveMenu>
                          )}
                        </TableCell>}
                        <TableCell className="font-mono text-xs">{agent.model}</TableCell>
                        <TableCell onClick={event => event.stopPropagation()}><AgentStatus agent={agent} /></TableCell>
                        <TableCell className="text-muted-foreground hidden md:table-cell" title={agent.lastActiveAt ? formatTime(agent.lastActiveAt) : undefined}>{agent.running ? "now" : formatAgo(agent.lastActiveAt)}</TableCell>
                        <TableCell className="text-muted-foreground hidden lg:table-cell">{agent.expiresAt === null ? "Never" : formatTime(agent.expiresAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
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
