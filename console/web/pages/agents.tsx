import { useMemo, useState } from "react";
import { Bot, ChevronDown, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { MoveMenu, ScopeCrumb, scopeName, WorkspaceTag } from "@/components/workspace-ui";
import { formatTime, type useApi, type AgentSummary, type Billing } from "@/lib/api";
import { docsUrl } from "@/lib/docs";
import { Link, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { moveToWorkspace, UNASSIGNED, useWorkspace, useWorkspaceDirectory } from "@/lib/workspace";

export function AgentStatus({ agent }: { agent: Pick<AgentSummary, "running" | "connected"> }) {
  if (agent.running) return <Badge variant="live">Running</Badge>;
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

/** The status filters the list endpoint's fields support today (failures and last activity come with the server's list). */
const FILTERS = {
  all: { label: "All", test: () => true },
  running: { label: "Running", test: (agent: AgentSummary) => agent.running },
  sub: { label: "Sub-agents", test: (agent: AgentSummary) => !!agent.parentAgentId },
  expiring: { label: "Expiring", test: (agent: AgentSummary) => agent.expiresAt !== null },
} as const;
type Filter = keyof typeof FILTERS;

/** Whether an agent matches a search: its name, key or id, ignoring case. */
export const matches = (agent: AgentSummary, query: string) => {
  const needle = query.trim().toLowerCase();
  return !needle || [agent.name, agent.key ?? "", agent.id].some(field => field.toLowerCase().includes(needle));
};

export function AgentsPage({ agents, billing }: {
  agents: ReturnType<typeof useApi<AgentSummary[]>>;
  billing: ReturnType<typeof useApi<Billing>>;
}) {
  const { ws, setWorkspace } = useWorkspace();
  const directory = useWorkspaceDirectory();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<unknown>();
  // Single-project accounts stay as simple as before: no workspace column, no selection.
  const grouped = !!directory.workspaces?.length;
  const scoped = useMemo(() => (agents.data ?? []).filter(agent => !grouped || directory.inScope("agent", agent.id, ws)), [agents.data, grouped, directory.inScope, ws]);
  const searched = scoped.filter(agent => matches(agent, query));
  const shown = searched.filter(FILTERS[filter].test);
  const rows = nested(shown);
  const picked = shown.filter(agent => selected.has(agent.id));
  const toggle = (id: string, on: boolean) => setSelected(current => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });
  const move = async (ids: string[], workspaceId: string | null) => {
    setMoving(true); setError(undefined);
    try { await moveToWorkspace("agent", ids, workspaceId); setSelected(new Set()); }
    catch (caught) { setError(caught); }
    finally { setMoving(false); }
  };
  const name = scopeName(directory, ws);
  const showWorkspace = grouped && ws === undefined;

  return (
    <>
      <ScopeCrumb directory={directory} />
      <PageHeader
        title="Agents"
        description="Agents in your account. Your application creates them with the SDK or POST /v1/agents." docs="concepts"
        actions={<>
          {!!agents.data?.length && <div className="relative">
            <Search aria-hidden="true" className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
            <Input type="search" aria-label="Search agents" placeholder="Search name, key or id" className="w-56 pl-7" value={query} onChange={event => setQuery(event.target.value)} />
          </div>}
          <Button variant="outline" size="sm" onClick={() => void agents.reload()}><RefreshCw />Refresh</Button>
        </>}
      />
      <ErrorAlert error={(error as Error | undefined) ?? agents.error ?? (grouped ? directory.error : undefined)} />
      <ErrorAlert error={agents.data?.length === 0 ? billing.error : undefined} />
      {(agents.loading && !agents.data) || (agents.data?.length && !directory.loaded && !directory.error) ? <Skeleton className="h-40 w-full" />
        : agents.data?.length === 0 ? (
          <EmptyState icon={<Bot />} title="No agents yet"
            action={<><Button size="sm" asChild><Link to="start">Get started</Link></Button><Button size="sm" variant="outline" asChild><a href={docsUrl("concepts")} target="_blank" rel="noreferrer">How agents work</a></Button></>}>
            An agent is a durable conversation with a model: its history, files and tools stay with it between runs. Try one in Get started, or make one from your code.
          </EmptyState>
        ) : !!agents.data?.length && (
          <>
            <div role="group" aria-label="Filter agents" className="mb-3 flex flex-wrap gap-2">
              {(Object.keys(FILTERS) as Filter[]).map(key => {
                const count = searched.filter(FILTERS[key].test).length;
                return <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={cn(
                  "focus-visible:ring-ring border px-2.5 py-1 text-xs outline-none focus-visible:ring-2",
                  filter === key ? "bg-foreground text-background border-foreground" : "bg-background hover:bg-accent",
                )}>{FILTERS[key].label} <span className="font-mono tabular-nums">{count}</span></button>;
              })}
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
            {rows.length === 0 ? (
              <EmptyState icon={<Bot />} title={query || filter !== "all" ? "No agents match" : ws === UNASSIGNED ? "Every agent is in a workspace" : `No agents in ${name ?? "this workspace"} yet`}
                action={query || filter !== "all" ? <Button size="sm" variant="outline" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</Button>
                  : <Button size="sm" variant="outline" onClick={() => setWorkspace(undefined)}>Show all workspaces</Button>}>
                {query || filter !== "all" ? "Nothing here matches the search and filter." : ws === UNASSIGNED ? "Agents in no workspace show here." : "Move agents here from All workspaces, or create them with this workspace's workspaceId."}
              </EmptyState>
            ) : (
              <div className="bg-card border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {grouped && <TableHead className="w-8"><input type="checkbox" aria-label="Select all shown agents" className="accent-foreground size-4 align-middle"
                        checked={picked.length === shown.length} ref={element => { if (element) element.indeterminate = picked.length > 0 && picked.length < shown.length; }}
                        onChange={event => setSelected(event.target.checked ? new Set(shown.map(agent => agent.id)) : new Set())} /></TableHead>}
                      <TableHead>Name</TableHead>
                      {showWorkspace && <TableHead>Workspace</TableHead>}
                      <TableHead>Model</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden lg:table-cell">Session expires</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map(({ agent, depth }) => {
                      const workspaceId = directory.workspaceOf("agent", agent.id);
                      return (
                        <TableRow key={agent.id} className="cursor-pointer" data-state={selected.has(agent.id) ? "selected" : undefined} onClick={() => navigate(`agents/${agent.id}`)}>
                          {grouped && <TableCell onClick={event => event.stopPropagation()}>
                            <input type="checkbox" aria-label={`Select ${agent.name}`} className="accent-foreground size-4 align-middle" checked={selected.has(agent.id)} onChange={event => toggle(agent.id, event.target.checked)} />
                          </TableCell>}
                          <TableCell style={depth ? { paddingLeft: `${0.5 + depth * 1.25}rem` } : undefined}>
                            {depth > 0 && <span className="text-muted-foreground mr-1" aria-label="sub-agent of the row above">↳</span>}<Link className="font-medium" to={`agents/${agent.id}`}>{agent.name}</Link>
                            {agent.key && depth === 0 && <div className="text-muted-foreground font-mono text-xs">key {agent.key}</div>}
                          </TableCell>
                          {showWorkspace && <TableCell onClick={event => event.stopPropagation()}>
                            {workspaceId ? <WorkspaceTag directory={directory} id={workspaceId} /> : (
                              <MoveMenu directory={directory} current={null} label="Assign to workspace" onMove={target => void move([agent.id], target)}>
                                <button type="button" className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4" disabled={moving}>Assign…</button>
                              </MoveMenu>
                            )}
                          </TableCell>}
                          <TableCell className="font-mono text-xs">{agent.model}</TableCell>
                          <TableCell><AgentStatus agent={agent} /></TableCell>
                          <TableCell className="text-muted-foreground hidden lg:table-cell">{agent.expiresAt === null ? "Never" : formatTime(agent.expiresAt)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
    </>
  );
}
