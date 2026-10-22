import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, FolderOpen, Plus, Search } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { CopyButton, EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { MoveMenu, ScopeCrumb, WorkspaceTag } from "@/components/workspace-ui";
import { WorkspaceSwatch } from "@/components/workspace-switcher";
import { AGENT_PAGE, api, formatCost, formatTime, useApi, useApiPage, type AgentSummary, type Channel, type Definition, type Usage, type Workspace } from "@/lib/api";
import { Link, navigate } from "@/lib/router";
import { AgentStatus } from "@/pages/agents";
import { changeWorkspaces, moveToWorkspace, useWorkspaceDirectory, WORKSPACES_CHANGED, type WorkspaceDirectory } from "@/lib/workspace";

const DESCRIPTION = "Group agents and definitions by project, team or customer, and see what each one spends.";

/** The index: a card per workspace with its spend and members, Unassigned as a dashed card, archived ones on a line. */
export function WorkspacesPage() {
  const directory = useWorkspaceDirectory();
  const agents = useApi<AgentSummary[]>("/v1/agents");
  const definitions = useApi<Definition[]>("/v1/definitions");
  const usage = useApi<Usage>("/v1/usage?days=30");
  const [creating, setCreating] = useState(location.hash === "#new");
  useEffect(() => {
    const open = () => { if (location.hash === "#new") setCreating(true); };
    addEventListener("popstate", open);
    return () => removeEventListener("popstate", open);
  }, []);
  const total = usage.data?.totals.cost ?? 0;
  const count = (id: string | null) => ({
    agents: agents.data?.filter(agent => (agent.workspaceId ?? directory.workspaceOf("agent", agent.id)) === id) ?? [],
    definitions: definitions.data?.filter(definition => directory.workspaceOf("definition", definition.id) === id) ?? [],
  });
  const spend = (id: string | null) => usage.data?.workspaces?.find(row => row.id === id)?.cost ?? 0;
  const active = directory.workspaces?.filter(workspace => !workspace.archived) ?? [];
  const archived = directory.workspaces?.filter(workspace => workspace.archived) ?? [];
  const unassigned = count(null);
  const newButton = <Button size="sm" onClick={() => setCreating(true)}><Plus />New workspace</Button>;

  return <>
    <ScopeCrumb directory={directory} />
    <PageHeader title="Workspaces" description={DESCRIPTION} actions={directory.workspaces?.length ? newButton : undefined} />
    <ErrorAlert error={directory.error ?? agents.error ?? definitions.error ?? usage.error} />
    {!directory.loaded ? <Skeleton className="h-40 w-full" />
      : !directory.workspaces?.length ? (
        <EmptyState icon={<FolderOpen />} title="Organize your agents" action={newButton}>
          A workspace groups agents and definitions for a project, team or customer, and adds up what they spend. Keys, channels and volumes stay account-wide.
        </EmptyState>
      ) : <>
        <div className="mb-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {active.map(workspace => {
            const members = count(workspace.id), cost = spend(workspace.id);
            const running = members.agents.filter(agent => agent.running).length;
            return <WorkspaceCard key={workspace.id} swatch={<WorkspaceSwatch index={directory.index(workspace.id)} />}
              title={<Link to={`workspaces/${workspace.id}`} className="hover:underline underline-offset-4">{workspace.name}</Link>}
              members={members} cost={cost} total={total} loaded={!!usage.data}
              footer={running > 0 && <Badge variant="live">{running} running</Badge>} />;
          })}
          <WorkspaceCard dashed swatch={<WorkspaceSwatch index="unassigned" />} title="Unassigned" members={unassigned} cost={spend(null)} total={total} loaded={!!usage.data}
            note="includes spend from before workspaces"
            footer={unassigned.agents.length > 0 && <Link to="agents?ws=unassigned" className="inline-flex items-center gap-1 text-sm underline underline-offset-4">Assign {unassigned.agents.length} agent{unassigned.agents.length === 1 ? "" : "s"}<ArrowRight className="size-3.5" /></Link>} />
        </div>
        {archived.length > 0 && <p className="text-muted-foreground text-sm">Archived: {archived.map((workspace, at) => <span key={workspace.id}>{at > 0 && ", "}
          <Link to={`workspaces/${workspace.id}`} className="text-foreground underline underline-offset-4">{workspace.name}</Link> ({formatCost(spend(workspace.id))} in 30 days)</span>)}</p>}
      </>}
    <NewWorkspaceDialog open={creating} onOpenChange={open => { setCreating(open); if (!open && location.hash) history.replaceState(null, "", location.pathname + location.search); }} />
  </>;
}

function WorkspaceCard({ swatch, title, members, cost, total, loaded, footer, note, dashed }: {
  swatch: ReactNode; title: ReactNode; members: { agents: unknown[]; definitions: unknown[] }; cost: number; total: number; loaded: boolean; footer?: ReactNode; note?: string; dashed?: boolean;
}) {
  const share = total > 0 ? cost / total : 0;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return (
    <div className={`bg-card border p-4 ${dashed ? "border-dashed" : ""}`}>
      <div className="flex items-center gap-2">{swatch}<span className="min-w-0 truncate font-semibold">{title}</span>
        <span className="text-muted-foreground ml-auto shrink-0 text-xs">{plural(members.agents.length, "agent")} · {plural(members.definitions.length, "definition")}</span></div>
      <div className="mt-3.5 font-mono text-2xl tabular-nums">{loaded ? formatCost(cost) : "…"}</div>
      <div className="text-muted-foreground text-xs">{note ?? `last 30 days · ${Math.round(share * 100)}% of spend`}</div>
      <div className="bg-chart-4 my-3 h-2" aria-hidden="true"><div className="bg-chart-3 h-full" style={{ width: `${Math.round(share * 100)}%` }} /></div>
      <div className="flex min-h-5 flex-wrap items-center gap-2">{footer}</div>
    </div>
  );
}

function NewWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try {
      const created = await changeWorkspaces(() => api<Workspace>("/v1/workspaces", { body: { name: name.trim() } }));
      setName(""); onOpenChange(false);
      navigate(`workspaces/${created.id}?ws=${created.id}`);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>For a project, team or customer. Add agents and definitions to it next; new agents made from its definitions join it.</DialogDescription>
          </DialogHeader>
          <ErrorAlert error={error} className="mb-0" />
          <Input aria-label="Workspace name" placeholder="Support bot" maxLength={120} autoFocus value={name} onChange={event => setName(event.target.value)} />
          <DialogFooter><Button type="submit" disabled={busy || !name.trim()}>Create workspace</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One workspace: its name and id, the definitions whose agents join it, its agents, and archiving. */
export function WorkspaceSettingsPage({ id }: { id: string }) {
  const directory = useWorkspaceDirectory();
  // Its agents, a page of them: the list is filtered on the server.
  const agents = useApiPage<AgentSummary>(`/v1/agents?workspaceId=${encodeURIComponent(id)}&limit=${AGENT_PAGE}`);
  const definitions = useApi<Definition[]>("/v1/definitions");
  const channels = useApi<Channel[]>("/v1/channels");
  const { reload: reloadAgents } = agents;
  useEffect(() => {
    const reload = () => void reloadAgents();
    addEventListener(WORKSPACES_CHANGED, reload);
    return () => removeEventListener(WORKSPACES_CHANGED, reload);
  }, [reloadAgents]);
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const workspace = directory.find(id);
  if (directory.loaded && !workspace) return <EmptyState icon={<FolderOpen />} title="No such workspace" action={<Button size="sm" variant="outline" asChild><Link to="workspaces?ws=">All workspaces</Link></Button>}>It may have been deleted, or belong to another account.</EmptyState>;
  if (!workspace) return <><ErrorAlert error={directory.error} /><Skeleton className="h-64 w-full" /></>;
  const run = async (action: () => Promise<unknown>) => { setError(undefined); try { await action(); } catch (caught) { setError((caught as Error).message); } };
  const members = agents.items ?? [];
  const ownDefinitions = definitions.data?.filter(definition => directory.workspaceOf("definition", definition.id) === id) ?? [];
  const otherDefinitions = definitions.data?.filter(definition => directory.workspaceOf("definition", definition.id) !== id) ?? [];

  return <div className="max-w-3xl">
    <ScopeCrumb directory={directory} />
    <PageHeader title="Workspace settings" description="Name, members and lifecycle of this workspace. Keys, channels and volumes are account-wide." />
    <ErrorAlert error={error ?? agents.error ?? definitions.error} />
    {workspace.archived && <Alert className="mb-6"><AlertTitle>Archived</AlertTitle><AlertDescription>Its agents keep running and its spend history stays. Restore it to add agents or definitions.</AlertDescription></Alert>}

    <Section title="Name">
      <RenameForm key={workspace.updatedAt} workspace={workspace} onError={setError} />
      <p className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-1 text-xs">ID <span className="text-foreground font-mono">{workspace.id}</span><CopyButton value={workspace.id} label="Copy workspace ID" />
        · use it as <span className="font-mono">workspaceId</span> when creating agents and runs. Created {formatTime(workspace.createdAt)}.</p>
    </Section>

    <Section title="Definitions" description="Agents created from these definitions (by your code or by a channel) join this workspace."
      action={<AddDefinition directory={directory} definitions={otherDefinitions} disabled={workspace.archived} onAdd={definition => void run(() => moveToWorkspace("definition", [definition], id))} />}>
      {ownDefinitions.length === 0 ? <p className="text-muted-foreground border border-dashed px-4 py-3 text-sm">No definitions yet.</p> : (
        <div className="bg-card border"><Table><TableBody>{ownDefinitions.map(definition => {
          const used = channels.data?.filter(channel => channel.definition === definition.id) ?? [];
          return <TableRow key={definition.id}>
            <TableCell className="font-medium">{definition.name} <span className="text-muted-foreground font-mono text-xs">rev {definition.revision}</span></TableCell>
            <TableCell className="text-muted-foreground hidden text-sm sm:table-cell">{used.length ? <>used by channel {used.map((channel, at) => <span key={channel.id}>{at > 0 && ", "}<Link to="channels" className="text-foreground underline underline-offset-4">{channel.name}</Link></span>)}</> : "no channel"}</TableCell>
            <TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => void run(() => moveToWorkspace("definition", [definition.id], null))}>Remove</Button></TableCell>
          </TableRow>;
        })}</TableBody></Table></div>
      )}
    </Section>

    <Section title={`Agents · ${members.length}${agents.next ? "+" : ""}`} description="Moving an agent changes where its future spend goes; earlier spend stays put."
      action={<Button size="sm" variant="outline" disabled={workspace.archived} onClick={() => setAdding(true)}><Plus />Add agents</Button>}>
      {!agents.items ? <Skeleton className="h-24 w-full" /> : members.length === 0 ? <p className="text-muted-foreground border border-dashed px-4 py-3 text-sm">No agents yet. Add existing ones, or create them with this workspace's id.</p> : (
        <div className="bg-card border"><Table><TableBody>{members.map(agent => (
          <TableRow key={agent.id}>
            <TableCell><Link to={`agents/${agent.id}`} className="font-medium hover:underline underline-offset-4">{agent.name}</Link></TableCell>
            <TableCell><AgentStatus agent={agent} /></TableCell>
            <TableCell className="text-muted-foreground hidden font-mono text-xs sm:table-cell">{agent.model}</TableCell>
            <TableCell className="text-right">
              <MoveMenu directory={directory} current={id} align="end" onMove={target => void run(() => moveToWorkspace("agent", [agent.id], target))}>
                <Button size="sm" variant="ghost">Move…</Button>
              </MoveMenu>
            </TableCell>
          </TableRow>
        ))}</TableBody></Table></div>
      )}
      {agents.next && <p className="mt-2 text-sm"><Link to={`agents?ws=${id}`} className="underline underline-offset-4">All of its agents in Agents</Link></p>}
    </Section>

    <Section title={workspace.archived ? "Restore" : "Archive"} last>
      <div className="bg-card flex flex-wrap items-center justify-between gap-4 border p-4">
        <p className="min-w-60 flex-1 text-sm">{workspace.archived ? "Restoring lets you assign agents and definitions to it again." : "Archiving keeps its agents running and its spend history, and stops new assignments. You can restore it later."}</p>
        <Button size="sm" variant={workspace.archived ? "outline" : "destructive"}
          onClick={() => void run(() => changeWorkspaces(() => api(`/v1/workspaces/${id}`, { method: "PATCH", body: { archived: !workspace.archived } })))}>
          {workspace.archived ? "Restore workspace" : "Archive workspace"}
        </Button>
      </div>
    </Section>
    <AddAgentsDialog open={adding} onOpenChange={setAdding} workspace={workspace} directory={directory}
      onAdd={ids => run(() => moveToWorkspace("agent", ids, id))} />
  </div>;
}

function Section({ title, description, action, children, last }: { title: string; description?: string; action?: ReactNode; children: ReactNode; last?: boolean }) {
  return (
    <section className={last ? "py-6" : "border-b py-6 first-of-type:pt-0"}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">{title}</h2>{action}</div>
      {description && <p className="text-muted-foreground mb-3 text-sm">{description}</p>}
      {!description && <div className="mb-2" />}
      {children}
    </section>
  );
}

function RenameForm({ workspace, onError }: { workspace: Workspace; onError: (message: string) => void }) {
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const changed = !!name.trim() && name.trim() !== workspace.name;
  return (
    <form className="flex max-w-md gap-2" onSubmit={async event => {
      event.preventDefault();
      setBusy(true);
      try { await changeWorkspaces(() => api(`/v1/workspaces/${workspace.id}`, { method: "PATCH", body: { name: name.trim() } })); }
      catch (caught) { onError((caught as Error).message); }
      finally { setBusy(false); }
    }}>
      <Input aria-label="Workspace name" maxLength={120} value={name} onChange={event => setName(event.target.value)} />
      <Button type="submit" variant="outline" disabled={busy || !changed}>Save</Button>
    </form>
  );
}

/** A dialog listing the account's other definitions, each with where it is now; picking one adds it. */
function AddDefinition({ directory, definitions, disabled, onAdd }: { directory: WorkspaceDirectory; definitions: Definition[]; disabled: boolean; onAdd: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" disabled={disabled || definitions.length === 0} onClick={() => setOpen(true)}><Plus />Add definition</Button>
      <DialogContent>
        <DialogHeader><DialogTitle>Add a definition</DialogTitle><DialogDescription>New agents made from it join this workspace. Agents it already made stay where they are.</DialogDescription></DialogHeader>
        <div className="max-h-80 overflow-y-auto border">
          {definitions.map(definition => (
            <button key={definition.id} type="button" className="hover:bg-accent focus-visible:bg-accent flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left text-sm outline-none last:border-b-0"
              onClick={() => { onAdd(definition.id); setOpen(false); }}>
              <span className="font-medium">{definition.name}</span>
              <WorkspaceTag directory={directory} id={directory.workspaceOf("definition", definition.id)} className="text-xs" />
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Pick agents from elsewhere (searchable, with where each is now) and move them here in one go. */
function AddAgentsDialog({ open, onOpenChange, workspace, directory, onAdd }: {
  open: boolean; onOpenChange: (open: boolean) => void; workspace: Workspace; directory: WorkspaceDirectory; onAdd: (ids: string[]) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  // Searched on the server: a page of matches, at most AGENT_PAGE.
  const [q, setQ] = useState("");
  useEffect(() => { const timer = setTimeout(() => setQ(query.trim()), 300); return () => clearTimeout(timer); }, [query]);
  const found = useApiPage<AgentSummary>(open ? `/v1/agents?limit=${AGENT_PAGE}${q ? `&q=${encodeURIComponent(q)}` : ""}` : undefined);
  const agents = found.items ?? found.previous ?? [];
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const candidates = agents.filter(agent => (agent.workspaceId ?? null) !== workspace.id);
  const close = (next: boolean) => { if (!next) { setPicked(new Set()); setQuery(""); } onOpenChange(next); };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add agents to {workspace.name}</DialogTitle><DialogDescription>Their future spend counts here; earlier spend stays where it happened.</DialogDescription></DialogHeader>
        <div className="relative">
          <Search aria-hidden="true" className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
          <Input type="search" aria-label="Search agents" placeholder="Search name, key or id" className="pl-7" value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        <div className="max-h-80 overflow-y-auto border">
          {candidates.length === 0 ? <p className="text-muted-foreground px-3 py-4 text-sm">No other agents{query ? " match" : ""}.</p> : candidates.map(agent => (
            <label key={agent.id} className="hover:bg-accent flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0">
              <input type="checkbox" className="accent-foreground size-4" checked={picked.has(agent.id)}
                onChange={event => setPicked(current => { const next = new Set(current); if (event.target.checked) next.add(agent.id); else next.delete(agent.id); return next; })} />
              <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
              <WorkspaceTag directory={directory} id={agent.workspaceId ?? null} className="text-xs" />
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button disabled={busy || picked.size === 0} onClick={async () => { setBusy(true); try { await onAdd([...picked]); close(false); } finally { setBusy(false); } }}>
            Add {picked.size || ""} agent{picked.size === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
