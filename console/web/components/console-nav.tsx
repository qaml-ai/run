import type { ReactNode } from "react";
import { ArrowUpRight, BookOpen } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { DOCS } from "@/lib/docs";
import { ACCOUNT_NAV, PRIMARY_NAV, START, groupOf, type NavItem } from "@/lib/nav";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

export const navItem = (active: boolean) =>
  cn(
    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-ring flex shrink-0 items-center gap-2 px-2.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2",
    active ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-muted-foreground",
  );

/**
 * The sidebar: primary views, then the Account group (account-wide settings and resources),
 * then Docs and Get started. At narrow widths the groups run as one scrolling row.
 */
export function ConsoleNav({
  active,
  start,
}: {
  active: string;
  start: { place: "top" | "footer"; progress?: ReactNode };
}) {
  const current = groupOf(active)?.to;
  const link = (item: NavItem, extra?: ReactNode) => {
    const on = groupOf(item.to.split("/")[0])?.to === current;
    return (
      <Link key={item.to} to={item.to} aria-current={on ? "page" : undefined} className={navItem(on)}>
        <item.icon aria-hidden="true" className="size-4" />
        {item.label}
        {extra}
      </Link>
    );
  };
  return (
    <div className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:gap-0.5 md:overflow-visible">
      {start.place === "top" && link(START, start.progress)}
      <nav aria-label="Primary" className="flex shrink-0 gap-1 md:flex-col md:gap-0.5">
        {PRIMARY_NAV.map(item => link(item))}
      </nav>
      <Separator orientation="vertical" className="mx-1 h-auto md:hidden" />
      <p
        className="text-muted-foreground hidden px-2.5 pt-4 pb-1.5 text-[10px] uppercase tracking-[0.3em] md:block"
        style={{ fontFamily: '"Silkscreen", monospace' }}
      >
        Account
      </p>
      <nav aria-label="Account" className="flex shrink-0 gap-1 md:flex-col md:gap-0.5">
        {ACCOUNT_NAV.map(item => link(item))}
      </nav>
      <Separator className="my-2 hidden md:block" />
      <Separator orientation="vertical" className="mx-1 h-auto md:hidden" />
      <a href={`${DOCS}/overview`} target="_blank" rel="noreferrer" className={navItem(false)}>
        <BookOpen aria-hidden="true" className="size-4" />
        Docs
        <ArrowUpRight className="ml-auto size-3" aria-hidden="true" />
      </a>
      {start.place === "footer" && link(START)}
    </div>
  );
}
