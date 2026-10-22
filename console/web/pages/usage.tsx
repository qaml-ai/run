import { useState } from "react";
import { ArrowRight, BarChart3, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, ErrorAlert, PageHeader, Stats } from "@/components/common";
import { DailyBars, SeriesSwatch, type Series } from "@/components/charts";
import { ScopeCrumb, scopeName } from "@/components/workspace-ui";
import { formatCost, formatNumber, useApi, type Usage } from "@/lib/api";
import { Link, navigate, useSearch } from "@/lib/router";
import { changeLabel, summarizeUsage } from "@/lib/usage";
import { UNASSIGNED, useWorkspace, useWorkspaceDirectory } from "@/lib/workspace";

export const RANGES = [{ days: 1, label: "Today (UTC)" }, { days: 7, label: "Last 7 days" }, { days: 30, label: "Last 30 days" }, { days: 90, label: "Last 90 days" }];
const TABS = { workspace: "By workspace", model: "By model", day: "By day" } as const;
type Tab = keyof typeof TABS;
/** Day × model rows per page of By day. */
export const DAY_PAGE = 25;

/** Usage's range and tab live in the URL (`?days=`, `?tab=`), beside the switcher's `?ws=`; a change replaces the entry. */
function useUsageQuery() {
  const search = new URLSearchParams(useSearch());
  const days = RANGES.find(range => String(range.days) === search.get("days"))?.days ?? 30;
  const set = (name: string, value: string | undefined) => {
    const next = new URLSearchParams(location.search);
    if (value === undefined) next.delete(name); else next.set(name, value);
    // An explicit empty ws keeps "all" from being filled in from memory.
    if (!next.has("ws")) next.set("ws", "");
    navigate(`usage?${next}`, { replace: true });
  };
  return { days, tab: search.get("tab") as Tab | null, setDays: (value: number) => set("days", value === 30 ? undefined : String(value)), setTab: (value: Tab) => set("tab", value) };
}

const csvCell = (value: unknown) => /[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value);
/** Download rows as a CSV file the browser saves. */
function downloadCsv(name: string, rows: (string | number)[][]) {
  const url = URL.createObjectURL(new Blob([rows.map(row => row.map(csvCell).join(",")).join("\n") + "\n"], { type: "text/csv" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function UsagePage() {
  const { ws, setWorkspace } = useWorkspace();
  const directory = useWorkspaceDirectory();
  const { days, tab: chosen, setDays, setTab } = useUsageQuery();
  const grouped = !!directory.workspaces?.length;
  const scope = grouped ? ws : undefined;
  const ready = directory.loaded || !!directory.error;
  // Twice the range, for the comparison with the period before.
  const usage = useApi<Usage>(ready ? `/v1/usage?days=${2 * days}${scope ? `&workspaceId=${encodeURIComponent(scope)}` : ""}` : undefined);
  const [page, setPage] = useState(0);
  const summary = usage.data ? summarizeUsage(usage.data, days) : undefined;
  const byWorkspace = grouped && scope === undefined;
  const tab: Tab = chosen && TABS[chosen] && (chosen !== "workspace" || byWorkspace) ? chosen : byWorkspace ? "workspace" : "model";
  const name = scopeName(directory, scope);
  const range = RANGES.find(entry => entry.days === days)!;

  // Each workspace, then Unassigned: the chart's stack (bottom first) and By workspace's rows.
  const workspaceRows = !summary || !byWorkspace ? [] : [
    ...(directory.workspaces ?? []).map(workspace => ({ id: workspace.id as string | null, name: workspace.name, archived: workspace.archived, look: { kind: "ramp" as const, index: directory.index(workspace.id) } })),
    { id: null, name: "Unassigned", archived: false, look: { kind: "outline" as const } },
  ].map(row => ({ ...row, ...(summary.workspaces.get(row.id) ?? { responses: 0, cost: 0, daily: summary.days.map(() => 0) }) }))
    .filter(row => !row.archived || row.cost || row.responses);
  const series: Series[] = !summary ? [] : byWorkspace
    ? workspaceRows.filter(row => row.cost > 0).map(row => ({ label: row.name, look: row.look, values: row.daily }))
    : [{ label: name ?? "Spend", look: scope && scope !== UNASSIGNED ? { kind: "ramp", index: directory.index(scope) } : scope === UNASSIGNED ? { kind: "outline" } : { kind: "ramp", index: 0 }, values: summary.daily.map(row => row.cost) }];
  const pages = summary ? Math.max(1, Math.ceil(summary.rows.length / DAY_PAGE)) : 1;
  const shownPage = Math.min(page, pages - 1);

  const exportCsv = () => {
    if (!summary) return;
    const file = `usage-${name ? name.replace(/\W+/g, "-").toLowerCase() : "all"}-${days}d-${tab}.csv`;
    if (tab === "workspace") downloadCsv(file, [["workspace", "responses", "cost_usd"], ...workspaceRows.map(row => [row.name, row.responses, row.cost.toFixed(6)])]);
    else if (tab === "model") downloadCsv(file, [["model", "responses", "input", "cache_read", "output", "cost_usd"], ...summary.models.map(row => [row.model, row.responses, row.input, row.cacheRead, row.output, row.cost.toFixed(6)])]);
    else downloadCsv(file, [["day", "model", "kind", "responses", "input", "cache_read", "output", "cost_usd"], ...summary.rows.map(row => [row.day, row.model, row.kind, row.responses, row.input, row.cacheRead, row.output, row.cost.toFixed(6)])]);
  };

  return (
    <>
      <ScopeCrumb directory={directory} />
      <PageHeader title="Usage" docs="pricing"
        description={`Model and tool spend from ${name ? `${name}'s agents` : "your agents"}${byWorkspace ? ", by workspace" : ""}. Model costs use provider reports when available and otherwise list-price estimates.`}
        actions={<>
          <Select value={String(days)} onValueChange={value => { setDays(Number(value)); setPage(0); }}>
            <SelectTrigger className="w-36" aria-label="Range"><SelectValue /></SelectTrigger>
            <SelectContent>{RANGES.map(entry => <SelectItem key={entry.days} value={String(entry.days)}>{entry.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" disabled={!summary} onClick={exportCsv}><Download />Export CSV</Button>
        </>} />
      <ErrorAlert error={usage.error ?? (grouped ? undefined : directory.error)} />
      {!summary ? <><Skeleton className="mb-8 h-16 w-full" /><Skeleton className="h-64 w-full" /></> : summary.totals.responses === 0 && summary.totals.cost === 0 ? (
        <EmptyState icon={<BarChart3 />} title={`No usage ${days === 1 ? "today" : `in the last ${days} days`}${name ? ` in ${name}` : ""}`}
          action={scope ? <Button size="sm" variant="outline" onClick={() => setWorkspace(undefined)}>Show all workspaces</Button>
            : <Button size="sm" variant="outline" asChild><Link to="agents">Your agents</Link></Button>}>
          Each model response and recorded tool call your agents make shows here, with its tokens and cost.
        </EmptyState>
      ) : <>
        <Stats items={[
          { label: "Model & tool spend", value: formatCost(summary.totals.cost), extra: <p className="text-muted-foreground mt-1 text-xs">{changeLabel(summary.totals.cost, summary.prior, days) ?? range.label}</p> },
          { label: "Responses", value: formatNumber(summary.totals.responses) },
          { label: "Input tokens", value: formatNumber(summary.totals.input + summary.totals.cacheRead + summary.totals.cacheWrite),
            extra: summary.totals.cacheRead > 0 && <p className="text-muted-foreground mt-1 text-xs">{Math.round((summary.totals.cacheRead / (summary.totals.input + summary.totals.cacheRead + summary.totals.cacheWrite)) * 100)}% cache reads</p> },
          { label: "Output tokens", value: formatNumber(summary.totals.output) },
        ]} />

        <section className="bg-card mb-6 border" aria-label={byWorkspace ? "Daily spend by workspace" : "Daily spend"}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <h2 className="text-sm font-semibold">{byWorkspace ? "Daily spend by workspace" : "Daily spend"}</h2>
            {byWorkspace && <ul className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs" aria-label="Legend">{series.map(entry => <li key={entry.label} className="inline-flex items-center gap-1.5"><SeriesSwatch look={entry.look} />{entry.label}</li>)}</ul>}
          </div>
          <div className="p-4">{days === 1 ? <p className="text-muted-foreground text-sm">One day: see By model and By day below.</p> : <DailyBars days={summary.days} series={series} />}</div>
        </section>

        <Tabs value={tab} onValueChange={value => { setTab(value as Tab); setPage(0); }}>
          <TabsList variant="line" className="mb-0">
            {(Object.keys(TABS) as Tab[]).filter(key => key !== "workspace" || byWorkspace).map(key => <TabsTrigger key={key} value={key}>{TABS[key]}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <div className="bg-card mt-2 border">
          {tab === "workspace" ? (
            <Table>
              <TableHeader><TableRow><TableHead>Workspace</TableHead><TableHead className="hidden sm:table-cell">Share</TableHead><TableHead className="text-right">Responses</TableHead><TableHead className="text-right">Cost</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{workspaceRows.map(row => (
                <TableRow key={row.id ?? "unassigned"} className={row.archived ? "text-muted-foreground" : undefined}>
                  <TableCell><span className="inline-flex items-center gap-2"><SeriesSwatch look={row.look} /><span className={row.id ? "font-medium" : undefined}>{row.name}</span>{row.archived && <Badge variant="outline">Archived</Badge>}</span></TableCell>
                  <TableCell className="hidden w-1/4 sm:table-cell"><div className="bg-chart-4 h-2" aria-hidden="true"><div className={row.id ? "bg-chart-3 h-full" : "bg-chart-2 h-full"} style={{ width: `${summary.totals.cost > 0 ? Math.round((row.cost / summary.totals.cost) * 100) : 0}%` }} /></div></TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.responses)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatCost(row.cost)}</TableCell>
                  <TableCell className="text-right">{row.id ? <button type="button" className="inline-flex items-center gap-1 text-xs underline underline-offset-4" onClick={() => setWorkspace(row.id!)}>Open<ArrowRight className="size-3" /></button>
                    : <Link to="agents?ws=unassigned" className="inline-flex items-center gap-1 text-xs underline underline-offset-4">Assign agents<ArrowRight className="size-3" /></Link>}</TableCell>
                </TableRow>
              ))}</TableBody>
              <TableFooter><TableRow><TableCell className="font-medium">Total</TableCell><TableCell className="hidden sm:table-cell" /><TableCell className="text-right font-mono tabular-nums">{formatNumber(summary.totals.responses)}</TableCell><TableCell className="text-right font-mono font-medium tabular-nums">{formatCost(summary.totals.cost)}</TableCell><TableCell /></TableRow></TableFooter>
            </Table>
          ) : tab === "model" ? (
            <Table>
              <TableHeader><TableRow><TableHead>Model or tool</TableHead><TableHead className="text-right">Responses</TableHead><TableHead className="hidden text-right md:table-cell">Input</TableHead><TableHead className="hidden text-right md:table-cell">Cached</TableHead><TableHead className="hidden text-right sm:table-cell">Output</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader>
              <TableBody>{summary.models.map(row => (
                <TableRow key={row.model}>
                  <TableCell className="font-mono text-xs">{row.model}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.responses)}</TableCell>
                  <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">{formatNumber(row.input)}</TableCell>
                  <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">{formatNumber(row.cacheRead)}</TableCell>
                  <TableCell className="hidden text-right font-mono tabular-nums sm:table-cell">{formatNumber(row.output)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatCost(row.cost)}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          ) : (
            <>
              <Table>
                <TableHeader><TableRow><TableHead>Day</TableHead><TableHead>Model</TableHead><TableHead className="text-right">Responses</TableHead><TableHead className="hidden text-right md:table-cell">Input</TableHead><TableHead className="hidden text-right md:table-cell">Cached</TableHead><TableHead className="hidden text-right sm:table-cell">Output</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader>
                <TableBody>{summary.rows.slice(shownPage * DAY_PAGE, (shownPage + 1) * DAY_PAGE).map(row => (
                  <TableRow key={`${row.day} ${row.model} ${row.kind}`}>
                    <TableCell className="tabular-nums">{row.day}</TableCell>
                    <TableCell className="font-mono text-xs">{row.model}{row.kind !== "turn" && <span className="text-muted-foreground ml-2 font-sans">{row.kind}</span>}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.responses)}</TableCell>
                    <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">{formatNumber(row.input)}</TableCell>
                    <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">{formatNumber(row.cacheRead)}</TableCell>
                    <TableCell className="hidden text-right font-mono tabular-nums sm:table-cell">{formatNumber(row.output)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatCost(row.cost)}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
              {pages > 1 && <nav aria-label="Pages" className="flex items-center justify-end gap-2 border-t px-3 py-2 text-sm">
                <span className="text-muted-foreground mr-2">Page {shownPage + 1} of {pages}</span>
                <Button size="sm" variant="outline" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}><ChevronLeft />Previous</Button>
                <Button size="sm" variant="outline" disabled={shownPage >= pages - 1} onClick={() => setPage(shownPage + 1)}>Next<ChevronRight /></Button>
              </nav>}
            </>
          )}
        </div>
        <p className="text-muted-foreground mt-3 text-xs">Days are UTC. Spend stays with the workspace an agent was in when the call happened; moving an agent does not move its history. Agent time and storage are account charges, on <Link to="billing" className="underline underline-offset-4">Billing</Link>.</p>
      </>}
    </>
  );
}
