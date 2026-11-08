import { useEffect, type ReactNode } from "react";
import { ArrowUpRight, BookOpen, Settings2 } from "lucide-react";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { Separator } from "@/components/ui/separator";
import type { Workspace } from "@/lib/api";
import { DOCS } from "@/lib/docs";
import { useApi } from "@/lib/api";
import { inboxCount, type InboxPage } from "@/lib/inbox";
import { ACCOUNT_NAV, START, WORKSPACE_NAV, groupOf, type NavItem } from "@/lib/nav";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { UNASSIGNED, useWorkspace } from "@/lib/workspace";

export const navItem = (active: boolean) => cn(
  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-ring flex shrink-0 items-center gap-2 px-2.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2",
  active ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-muted-foreground",
);

/**
 * The sidebar: the workspace switcher over the pages it scopes, then the Account group (account-wide pages that never
 * change with it), then Docs and help. At narrow widths the groups run as one scrolling row under the switcher.
 */
export function ConsoleNav({ active, workspaces, start, help }: {
  /** The current page's section ("" for home, which is the agents list until Overview lands). */
  active: string;
  workspaces: Workspace[] | undefined;
  /** Get started's place: "top" while a path is in progress (with its progress), "footer" after. */
  start: { place: "top" | "footer"; progress?: ReactNode };
  help?: ReactNode;
}) {
  const inbox = useApi<InboxPage>("/v1/inbox?limit=1", 15_000);
  useEffect(() => { const changed = () => { void inbox.reload(); }; window.addEventListener("inbox-changed", changed); return () => window.removeEventListener("inbox-changed", changed); }, [inbox.reload]);
  const { ws, forgetWorkspace } = useWorkspace();
  // A selection this account doesn't have (deleted, another account's in this browser, or any with no workspaces) falls back to all.
  const stale = !!workspaces && !!ws && (workspaces.length === 0 || (ws !== UNASSIGNED && !workspaces.some(workspace => workspace.id === ws)));
  useEffect(() => { if (stale) forgetWorkspace(); }, [stale, forgetWorkspace]);
  const current = groupOf(active)?.to;
  // With one workspace selected, its settings take the Workspaces index's place.
  const selected = ws && ws !== UNASSIGNED ? workspaces?.find(workspace => workspace.id === ws) : undefined;
  const scoped = WORKSPACE_NAV.map(item => item.to === "workspaces" && selected ? { ...item, to: `workspaces/${selected.id}`, label: "Workspace settings", icon: Settings2 } : item);
  const link = (item: NavItem, extra?: ReactNode) => {
    const on = groupOf(item.to.split("/")[0])?.to === current;
    return <Link key={item.to} to={item.to} aria-current={on ? "page" : undefined} className={navItem(on)}><item.icon aria-hidden="true" className="size-4" />{item.label}{item.to === "inbox" && inboxCount(inbox.data) > 0 && <span aria-label={`${inboxCount(inbox.data)} unanswered`} className="ml-auto rounded-full bg-primary px-2 text-xs text-primary-foreground">{inboxCount(inbox.data)}</span>}{extra}</Link>;
  };
  return (
    <>
      {workspaces?.length ? <div className="px-3 pb-3"><WorkspaceSwitcher workspaces={workspaces} /></div> : null}
      <div className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:gap-0.5 md:overflow-visible">
        {link(WORKSPACE_NAV.find(item => item.to === "agents")!)}
        {link(ACCOUNT_NAV.find(item => item.to === "inbox")!)}
        {start.place === "top" && link(START, start.progress)}
        <nav aria-label="Workspace" className="flex shrink-0 gap-1 md:flex-col md:gap-0.5">{scoped.filter(item => item.to !== "agents").map(item => link(item))}</nav>
        <Separator orientation="vertical" className="mx-1 h-auto md:hidden" />
        <p className="text-muted-foreground hidden px-2.5 pt-4 pb-1.5 text-[10px] uppercase tracking-[0.3em] md:block" style={{ fontFamily: '"Silkscreen", monospace' }}>Account</p>
        <nav aria-label="Account" className="flex shrink-0 gap-1 md:flex-col md:gap-0.5">{ACCOUNT_NAV.filter(item => item.to !== "inbox").map(item => link(item))}</nav>
        <Separator className="my-2 hidden md:block" />
        <Separator orientation="vertical" className="mx-1 h-auto md:hidden" />
        <a href={`${DOCS}/overview`} target="_blank" rel="noreferrer" className={navItem(false)}><BookOpen aria-hidden="true" className="size-4" />Docs<ArrowUpRight className="ml-auto size-3" aria-hidden="true" /></a>
        {start.place === "footer" && link(START)}
        {help}
      </div>
    </>
  );
}
