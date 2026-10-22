import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AdminGrowth } from "../../../../src/admin-growth";
import { PIXEL_STYLE } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { FullLogo } from "@/components/ui/logo";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { clock, count, plural, RANGES, readView, useOps, useOpsActivity, viewSearch, type OpsRange, type OpsTab } from "@/lib/ops";
import { cn } from "@/lib/utils";
import { AdminAnalytics } from "../admin-analytics";
import { AccountDialog } from "./account-dialog";
import { GrowthTab } from "./growth-tab";
import { HealthTab } from "./health-tab";
import { McpTab } from "./mcp-tab";
import { Choice, Hint } from "./parts";
import { RevenueTab } from "./revenue-tab";
import { UsageTab } from "./usage-tab";

const TAB_LABELS: Record<OpsTab, string> = { growth: "Growth", mcp: "MCP plugins", usage: "Usage", revenue: "Revenue", health: "Health", journeys: "Journeys" };

/**
 * The team's ops dashboard (the admin site, src/admin-site.ts, behind Cloudflare Access): Growth, Usage, Revenue,
 * Health and Journeys, each answering one question. The tab and the range (7, 30 or 90 UTC days) are in the address, so
 * a view can be linked. Refresh reads every figure again; an account opened from any table shows in a dialog.
 */
export function OpsPage() {
  const [view, setView] = useState(() => readView(typeof location === "undefined" ? "" : location.search));
  const [refresh, setRefresh] = useState(0);
  // Usage starts with self-serve accounts only; Health with everyone, since its totals are the platform's.
  const [everyone, setEveryone] = useState({ usage: false, health: true });
  const [account, setAccount] = useState<string | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const me = useOps<{ viewer: string }>("/api/me");
  const growth = useOps<AdminGrowth>(`/api/growth?days=${view.days}`, refresh);
  const activity = useOpsActivity();

  useEffect(() => { document.title = "camelRun ops"; }, []);
  useEffect(() => {
    const search = viewSearch(location.search, view);
    if (search !== location.search) history.replaceState(history.state, "", `${location.pathname}${search}${location.hash}`);
  }, [view]);

  const pick = (tab: string) => {
    setView(current => ({ ...current, tab: tab as OpsTab }));
    // A tab picked lower down the page starts at its top, under the tab row.
    const top = anchor.current ? anchor.current.getBoundingClientRect().top + window.scrollY : 0;
    if (window.scrollY > top) window.scrollTo({ top });
  };
  const switchable = view.tab === "usage" || view.tab === "health" ? view.tab : undefined;
  const data = growth.data;

  return (
    <div className="min-h-dvh">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-start justify-between gap-x-6 gap-y-3 px-4 py-4 md:px-6">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2.5">
              <FullLogo className="h-5 w-auto" />
              <span aria-hidden="true" className="bg-border block h-4 w-px" />
              <span className="text-[13px] tracking-[0.08em] uppercase" style={PIXEL_STYLE}>ops</span>
            </h1>
            <div className="mt-2.5 max-w-[70ch] text-sm" aria-live="polite">
              {data ? <>
                {plural(data.accounts, "self-serve account")}. {count(data.tiles.signups.current)} signed up in the last {view.days} days;{" "}
                {count(data.tiles.weekly_active.current)} did work this week.
              </> : growth.error ? <span className="text-muted-foreground">The headline figures could not be read.</span> : <Skeleton className="h-5 w-96 max-w-full" />}
            </div>
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            {me.data && <span className="min-w-0 truncate">Signed in as <span className="text-foreground">{me.data.viewer}</span></span>}
            {activity.updated && <span className="tabular-nums">Updated {clock(activity.updated)}</span>}
            <Button variant="outline" size="sm" onClick={() => setRefresh(value => value + 1)} disabled={activity.loading > 0}>
              <RefreshCw className={cn(activity.loading > 0 && "animate-spin")} aria-hidden="true" />Refresh
            </Button>
          </div>
        </div>
      </header>

      <Tabs value={view.tab} onValueChange={pick} className="gap-0">
        <div ref={anchor} aria-hidden="true" />
        {/* Held at the top as the page scrolls, so another tab or range is always one click away. */}
        <div className="bg-background sticky top-0 z-30 border-b">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2 md:px-6">
            <TabsList variant="line" aria-label="Dashboard sections" className="-ml-1.5 h-9 gap-0.5">
              {(Object.keys(TAB_LABELS) as OpsTab[]).map(tab => (
                <TabsTrigger key={tab} value={tab} className="px-2.5 text-sm after:bottom-[-9px]">{TAB_LABELS[tab]}</TabsTrigger>
              ))}
            </TabsList>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:gap-x-5">
              {switchable && (
                <div className="flex items-center gap-1.5 text-xs">
                  <Switch id="ops-everyone" checked={everyone[switchable]} onCheckedChange={checked => setEveryone(current => ({ ...current, [switchable]: checked }))} />
                  <label htmlFor="ops-everyone" className="cursor-pointer pl-0.5"><span className="sm:hidden">camelBot &amp; operators</span><span className="hidden sm:inline">Include camelBot &amp; operator accounts</span></label>
                  <Hint>
                    Off: only accounts people made for themselves. On: also camelBot and the runtime&rsquo;s other admin tenants, accounts an operator made, and the
                    team&rsquo;s own. {switchable === "health" ? "Health's totals are always the platform's; the switch changes who the spend is shown for." : ""}
                  </Hint>
                </div>
              )}
              {view.tab !== "journeys" && (
                <Choice label="Days shown" value={view.days} onChange={(days: OpsRange) => setView(current => ({ ...current, days }))}
                  options={RANGES.map(days => ({ value: days, label: `${days} days` }))} />
              )}
            </div>
          </div>
        </div>

        <main className="mx-auto w-full max-w-6xl px-4 pt-6 pb-16 md:px-6 md:pt-8">
          <TabsContent value="growth" className="text-sm"><GrowthTab days={view.days} refresh={refresh} growth={growth} /></TabsContent>
          <TabsContent value="mcp" className="text-sm"><McpTab days={view.days} refresh={refresh} /></TabsContent>
          <TabsContent value="usage" className="text-sm"><UsageTab days={view.days} refresh={refresh} everyone={everyone.usage} onAccount={setAccount} /></TabsContent>
          <TabsContent value="revenue" className="text-sm"><RevenueTab days={view.days} refresh={refresh} onAccount={setAccount} /></TabsContent>
          <TabsContent value="health" className="text-sm"><HealthTab days={view.days} refresh={refresh} everyone={everyone.health} onAccount={setAccount} /></TabsContent>
          <TabsContent value="journeys" className="text-sm"><AdminAnalytics refresh={refresh} /></TabsContent>
        </main>
      </Tabs>
      <AccountDialog tenant={account} days={view.days} refresh={refresh} onClose={() => setAccount(null)} />
    </div>
  );
}
