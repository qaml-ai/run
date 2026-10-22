import type { ReactNode } from "react";
import { WorkspaceSwatch } from "@/components/workspace-switcher";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { UNASSIGNED, useWorkspace, type WorkspaceDirectory } from "@/lib/workspace";

/** A workspace's square and name; "Unassigned" (muted) for none. */
export function WorkspaceTag({ directory, id, className }: { directory: WorkspaceDirectory; id: string | null; className?: string }) {
  const workspace = directory.find(id);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-sm", !workspace && "text-muted-foreground", className)}>
      <WorkspaceSwatch index={workspace ? directory.index(workspace.id) : UNASSIGNED} className="size-2" />
      <span className="truncate">{workspace ? workspace.name : "Unassigned"}</span>
      {workspace?.archived && <span className="text-muted-foreground text-xs">(archived)</span>}
    </span>
  );
}

/** A menu of where to move something: each active workspace, then Unassigned. `current` is shown checked and can't be picked. */
export function MoveMenu({ directory, current, onMove, children, label = "Move to workspace", align = "start" }: {
  directory: WorkspaceDirectory; current?: string | null; onMove: (workspaceId: string | null) => void; children: ReactNode; label?: string; align?: "start" | "end";
}) {
  const active = directory.workspaces?.filter(workspace => !workspace.archived) ?? [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-56" onClick={event => event.stopPropagation()}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {active.map(workspace => (
          <DropdownMenuItem key={workspace.id} disabled={workspace.id === current} onSelect={() => onMove(workspace.id)}>
            <WorkspaceSwatch index={directory.index(workspace.id)} /><span className="truncate">{workspace.name}</span>
            {workspace.id === current && <span className="text-muted-foreground ml-auto pl-3 text-xs">current</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={current === null} onSelect={() => onMove(null)}>
          <WorkspaceSwatch index={UNASSIGNED} />Unassigned{current === null && <span className="text-muted-foreground ml-auto pl-3 text-xs">current</span>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Above a scoped page's title: the workspace it shows, so a filtered list never looks like the whole account. */
export function ScopeCrumb({ directory }: { directory: WorkspaceDirectory }) {
  const { ws } = useWorkspace();
  if (!directory.workspaces?.length) return null;
  const workspace = ws && ws !== UNASSIGNED ? directory.find(ws) : undefined;
  return (
    <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-sm">
      <WorkspaceSwatch className="size-2" index={workspace ? directory.index(workspace.id) : ws === UNASSIGNED ? UNASSIGNED : "all"} />
      {workspace ? workspace.name : ws === UNASSIGNED ? "Unassigned" : "All workspaces"}
    </p>
  );
}

/** The selected workspace's name for copy ("No agents in Support bot"), or undefined for all. */
export function scopeName(directory: WorkspaceDirectory, ws: string | undefined) {
  return ws === UNASSIGNED ? "Unassigned" : ws ? directory.find(ws)?.name : undefined;
}
