import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, formatCost, useApi, type AgentSummary, type Workspace, type WorkspaceMembership, type Usage } from "@/lib/api";
import { Link } from "@/lib/router";

export function WorkspacesPage() {
  const workspaces = useApi<Workspace[]>("/v1/workspaces");
  const memberships = useApi<WorkspaceMembership[]>("/v1/workspace-memberships");
  const agents = useApi<AgentSummary[]>("/v1/agents");
  const definitions = useApi<{ id: string; name: string }[]>("/v1/definitions");
  const usage = useApi<Usage>("/v1/usage?days=30");
  const [name, setName] = useState("");
  const [error, setError] = useState<any>();
  const [busy, setBusy] = useState(false);
  async function write(action: () => Promise<unknown>) {
    setBusy(true); setError(undefined);
    try { await action(); await Promise.all([workspaces.reload(), memberships.reload(), usage.reload()]); }
    catch (error) { setError(error); }
    finally { setBusy(false); }
  }
  const resources = [...(agents.data ?? []).map(agent => ({ ...agent, kind: "agent" as const })), ...(definitions.data ?? []).map(definition => ({ ...definition, kind: "definition" as const }))];
  return <>
    <PageHeader title="Workspaces" description="Group agents and definitions by project. New agents inherit their definition’s workspace. Earlier spend stays where it happened." />
    <ErrorAlert error={error ?? workspaces.error ?? memberships.error ?? agents.error ?? definitions.error ?? usage.error} />
    <form className="mb-6 flex max-w-lg gap-2" onSubmit={event => { event.preventDefault(); void write(async () => { await api("/v1/workspaces", { body: { name: name.trim() } }); setName(""); }); }}>
      <Input aria-label="Workspace name" placeholder="Workspace name" maxLength={120} value={name} onChange={event => setName(event.target.value)} />
      <Button disabled={busy || !name.trim()}>Create workspace</Button>
    </form>
    {workspaces.data?.length === 0 ? <EmptyState icon={<FolderOpen />} title="Organize your agents">Create a workspace for a project, team, or use case, then assign its agents below.</EmptyState> : <div className="mb-8 border bg-card">
      <Table><TableHeader><TableRow><TableHead>Workspace</TableHead><TableHead className="text-right">Spend · last 30 days</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>{workspaces.data?.map(workspace => <WorkspaceRow key={workspace.id} workspace={workspace} busy={busy} cost={usage.data?.workspaces?.find(row => row.id === workspace.id)?.cost ?? 0} write={write} />)}</TableBody>
      </Table>
    </div>}
    <h2 className="mb-2 text-lg font-medium">Agents and definitions</h2>
    <p className="mb-4 text-sm text-muted-foreground">Assigning a definition groups agents created from it later. Assign existing agents individually. Archiving a workspace keeps its members and spend history.</p>
    <div className="border bg-card"><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Kind</TableHead><TableHead>Workspace</TableHead></TableRow></TableHeader>
      <TableBody>{resources.map(resource => {
        const selected = memberships.data?.find(member => member.kind === resource.kind && member.id === resource.id)?.workspaceId ?? "";
        return <TableRow key={`${resource.kind}:${resource.id}`}>
          <TableCell><Link to={resource.kind === "agent" ? `agents/${resource.id}` : "definitions"}>{resource.name || resource.id}</Link></TableCell>
          <TableCell>{resource.kind === "agent" ? "Agent" : "Definition"}</TableCell>
          <TableCell><select className="h-9 w-full max-w-xs border bg-background px-2 text-sm" aria-label={`Workspace for ${resource.name || resource.id}`} value={selected} disabled={busy || !memberships.data || !workspaces.data}
            onChange={event => { const workspaceId = event.target.value || null; void write(() => api(`/v1/workspace-memberships/${resource.kind}/${resource.id}`, { method: "PUT", body: { workspaceId } })); }}>
            <option value="">Unassigned</option>
            {workspaces.data?.filter(workspace => !workspace.archived || workspace.id === selected).map(workspace => <option key={workspace.id} value={workspace.id} disabled={workspace.archived}>{workspace.name}{workspace.archived ? " (archived)" : ""}</option>)}
          </select></TableCell>
        </TableRow>;
      })}</TableBody>
    </Table></div>
  </>;
}

function WorkspaceRow({ workspace, cost, busy, write }: { workspace: Workspace; cost: number; busy: boolean; write: (action: () => Promise<unknown>) => Promise<void> }) {
  const [name, setName] = useState(workspace.name);
  return <TableRow>
    <TableCell><Input aria-label={`Rename ${workspace.name}`} value={name} maxLength={120} onChange={event => setName(event.target.value)} /></TableCell>
    <TableCell className="text-right font-mono tabular-nums"><Link to={`usage?workspaceId=${workspace.id}`}>{formatCost(cost)}</Link></TableCell>
    <TableCell>{workspace.archived ? "Archived" : "Active"}</TableCell>
    <TableCell><div className="flex justify-end gap-2">
      <Button size="sm" variant="outline" disabled={busy || !name.trim() || name.trim() === workspace.name} onClick={() => void write(() => api(`/v1/workspaces/${workspace.id}`, { method: "PATCH", body: { name: name.trim() } }))}>Save name</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void write(() => api(`/v1/workspaces/${workspace.id}`, { method: "PATCH", body: { archived: !workspace.archived } }))}>{workspace.archived ? "Restore" : "Archive"}</Button>
    </div></TableCell>
  </TableRow>;
}
