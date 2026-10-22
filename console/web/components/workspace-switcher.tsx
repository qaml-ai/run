import { useState, type CSSProperties } from "react";
import { ChevronsUpDown, Plus, Settings2 } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatCost, useApi, type Usage, type Workspace } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { UNASSIGNED, useWorkspace } from "@/lib/workspace";

const ALL = "all";
// Workspaces wear the gray ramp, never a hue: signal blue keeps meaning "live".
const RAMP = ["var(--chart-3)", "var(--chart-2)", "var(--chart-4)"];

/** A workspace's square: its place on the ramp (then hatched), a dashed outline for all, an empty one for unassigned. */
export function WorkspaceSwatch({ index, className }: { index: number | typeof ALL | typeof UNASSIGNED; className?: string }) {
  const style: CSSProperties = index === ALL ? { border: "1px dashed var(--ring)" }
    : index === UNASSIGNED ? { border: "1px solid var(--ring)" }
    : index < RAMP.length ? { background: RAMP[index] }
    : { background: "repeating-linear-gradient(45deg, var(--chart-3) 0 2px, transparent 2px 4px)", border: "1px solid var(--chart-3)" };
  return <span aria-hidden="true" className={cn("size-2.5 shrink-0", className)} style={style} />;
}

/**
 * The sidebar's workspace switcher: a menu of All workspaces, each workspace, Unassigned (archived ones in a submenu),
 * with each one's last 30 days of spend. It renders nothing for an account with no workspaces, where all is all there is.
 */
export function WorkspaceSwitcher({ workspaces }: { workspaces: Workspace[] | undefined }) {
  const { ws, setWorkspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const usage = useApi<Usage>(open ? "/v1/usage?days=30" : undefined);
  if (!workspaces?.length) return null;
  const known = !ws || ws === UNASSIGNED || workspaces.some(workspace => workspace.id === ws);

  const index = (id: string) => workspaces.findIndex(workspace => workspace.id === id);
  const active = workspaces.filter(workspace => !workspace.archived), archived = workspaces.filter(workspace => workspace.archived);
  const selected = ws === UNASSIGNED ? { name: "Unassigned", swatch: UNASSIGNED as typeof UNASSIGNED }
    : ws && known ? { name: workspaces[index(ws)].name, swatch: index(ws) }
    : { name: "All workspaces", swatch: ALL as typeof ALL };
  const spend = (id: string | null | typeof ALL) => {
    if (!usage.data) return undefined;
    const cost = id === ALL ? usage.data.totals.cost : usage.data.workspaces?.find(row => row.id === id)?.cost ?? 0;
    return <span className="text-muted-foreground ml-auto pl-3 font-mono text-xs tabular-nums">{formatCost(cost)}</span>;
  };
  const choose = (value: string) => { if (value !== (ws ?? ALL)) setWorkspace(value === ALL ? undefined : value); };
  const row = (workspace: Workspace) => (
    <DropdownMenuRadioItem key={workspace.id} value={workspace.id}>
      <WorkspaceSwatch index={index(workspace.id)} /><span className="min-w-0 truncate">{workspace.name}</span>{spend(workspace.id)}
    </DropdownMenuRadioItem>
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className="bg-card hover:bg-sidebar-accent focus-visible:ring-ring flex w-full min-w-0 items-center gap-2.5 border px-2.5 py-2 text-left outline-none focus-visible:ring-2">
        <WorkspaceSwatch index={selected.swatch} />
        <span className="min-w-0 flex-1">
          <span className="text-muted-foreground block text-[9px] uppercase tracking-[0.3em]" style={{ fontFamily: '"Silkscreen", monospace' }}>Workspace</span>
          <span className="block truncate text-sm font-semibold">{selected.name}</span>
        </span>
        <ChevronsUpDown aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-72">
        <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={ws ?? ALL} onValueChange={choose}>
          <DropdownMenuRadioItem value={ALL}><WorkspaceSwatch index={ALL} />All workspaces{spend(ALL)}</DropdownMenuRadioItem>
          {active.map(row)}
          <DropdownMenuRadioItem value={UNASSIGNED}><WorkspaceSwatch index={UNASSIGNED} />Unassigned{spend(null)}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {archived.length > 0 && <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-muted-foreground">Archived ({archived.length})</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-60">
            <DropdownMenuRadioGroup value={ws ?? ALL} onValueChange={choose}>{archived.map(row)}</DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>}
        <DropdownMenuItem onSelect={() => navigate("workspaces#new")}><Plus />New workspace</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("workspaces")}><Settings2 />Manage workspaces</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
