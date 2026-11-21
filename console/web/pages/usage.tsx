import { useState } from "react";
import { BarChart3, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, ErrorAlert, PageHeader, Stats } from "@/components/common";
import { DailyBars, type Series } from "@/components/charts";
import { formatCost, formatNumber, useApi, type UsageResponse } from "@/lib/api";
import { Link, navigate, useSearch } from "@/lib/router";
import { changeLabel, summarizeUsage } from "@/lib/usage";

export const RANGES = [
  { days: 1, label: "Today (UTC)" },
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];
const TABS = { model: "By model", day: "By day" } as const;
type Tab = keyof typeof TABS;
export const DAY_PAGE = 25;

function useUsageQuery() {
  const search = new URLSearchParams(useSearch());
  const days = RANGES.find(range => String(range.days) === search.get("days"))?.days ?? 30;
  const set = (name: string, value: string | undefined) => {
    const next = new URLSearchParams(location.search);
    if (value === undefined) next.delete(name);
    else next.set(name, value);
    const qs = next.toString();
    navigate(qs ? `usage?${qs}` : "usage", { replace: true });
  };
  return {
    days,
    tab: search.get("tab") as Tab | null,
    setDays: (value: number) => set("days", value === 30 ? undefined : String(value)),
    setTab: (value: Tab) => set("tab", value),
  };
}

const csvCell = (value: unknown) => (/[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));

function downloadCsv(name: string, rows: (string | number)[][]) {
  const url = URL.createObjectURL(new Blob([rows.map(row => row.map(csvCell).join(",")).join("\n") + "\n"], { type: "text/csv" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function UsagePage() {
  const { days, tab: chosen, setDays, setTab } = useUsageQuery();
  const usage = useApi<UsageResponse>(`/v2/usage?days=${2 * days}`);
  const [page, setPage] = useState(0);
  const summary = usage.data ? summarizeUsage(usage.data, days) : undefined;
  const tab: Tab = chosen && TABS[chosen] ? chosen : "model";
  const range = RANGES.find(entry => entry.days === days)!;

  const series: Series[] = !summary
    ? []
    : [{ label: "Spend", look: { kind: "ramp", index: 0 }, values: summary.daily.map(row => row.cost) }];
  const pages = summary ? Math.max(1, Math.ceil(summary.rows.length / DAY_PAGE)) : 1;
  const shownPage = Math.min(page, pages - 1);

  const exportCsv = () => {
    if (!summary) return;
    const file = `usage-${days}d-${tab}.csv`;
    if (tab === "model") {
      downloadCsv(file, [
        ["model", "responses", "input", "output", "cost_usd"],
        ...summary.models.map(row => [row.model, row.responses, row.input, row.output, row.cost.toFixed(6)]),
      ]);
    } else {
      downloadCsv(file, [
        ["day", "model", "kind", "responses", "input", "output", "cost_usd"],
        ...summary.rows.map(row => [row.day, row.model, row.kind, row.responses, row.input, row.output, row.cost.toFixed(6)]),
      ]);
    }
  };

  return (
    <>
      <PageHeader
        title="Usage"
        docs="pricing"
        description="Model and runtime spend recorded across your agents. Days are UTC."
        actions={
          <>
            <Select value={String(days)} onValueChange={value => { setDays(Number(value)); setPage(0); }}>
              <SelectTrigger className="w-36" aria-label="Range"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RANGES.map(entry => <SelectItem key={entry.days} value={String(entry.days)}>{entry.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" disabled={!summary} onClick={exportCsv}>
              <Download />Export CSV
            </Button>
          </>
        }
      />
      <ErrorAlert error={usage.error} />
      {!summary ? (
        <>
          <Skeleton className="mb-8 h-16 w-full" />
          <Skeleton className="h-64 w-full" />
        </>
      ) : summary.totals.responses === 0 && summary.totals.cost === 0 ? (
        <EmptyState
          icon={<BarChart3 />}
          title={`No usage ${days === 1 ? "today" : `in the last ${days} days`}`}
          action={<Button size="sm" variant="outline" asChild><Link to="agents">Your agents</Link></Button>}
        >
          Each model run your agents complete shows up here with its tokens and cost.
        </EmptyState>
      ) : (
        <>
          <Stats
            items={[
              {
                label: "Model & runtime spend",
                value: formatCost(summary.totals.cost),
                extra: <p className="text-muted-foreground mt-1 text-xs">{changeLabel(summary.totals.cost, summary.prior, days) ?? range.label}</p>,
              },
              { label: "Responses", value: formatNumber(summary.totals.responses) },
              { label: "Input tokens", value: formatNumber(summary.totals.input) },
              { label: "Output tokens", value: formatNumber(summary.totals.output) },
            ]}
          />

          <section className="bg-card mb-6 border" aria-label="Daily spend">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Daily spend</h2>
            </div>
            <div className="p-4">
              {days === 1 ? (
                <p className="text-muted-foreground text-sm">One day: see By model and By day below.</p>
              ) : (
                <DailyBars days={summary.days} series={series} />
              )}
            </div>
          </section>

          <Tabs value={tab} onValueChange={value => { setTab(value as Tab); setPage(0); }}>
            <TabsList variant="line" className="mb-0">
              {(Object.keys(TABS) as Tab[]).map(key => <TabsTrigger key={key} value={key}>{TABS[key]}</TabsTrigger>)}
            </TabsList>
          </Tabs>

          <div className="bg-card mt-2 border">
            {tab === "model" ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Responses</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Input</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Output</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.models.map(row => (
                    <TableRow key={row.model}>
                      <TableCell className="font-mono text-xs">{row.model}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.responses)}</TableCell>
                      <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">{formatNumber(row.input)}</TableCell>
                      <TableCell className="hidden text-right font-mono tabular-nums sm:table-cell">{formatNumber(row.output)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatCost(row.cost)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Day</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">Responses</TableHead>
                      <TableHead className="hidden text-right md:table-cell">Input</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Output</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.rows.slice(shownPage * DAY_PAGE, (shownPage + 1) * DAY_PAGE).map(row => (
                      <TableRow key={`${row.day} ${row.model} ${row.kind}`}>
                        <TableCell className="tabular-nums">{row.day}</TableCell>
                        <TableCell className="font-mono text-xs">{row.model}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.responses)}</TableCell>
                        <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">{formatNumber(row.input)}</TableCell>
                        <TableCell className="hidden text-right font-mono tabular-nums sm:table-cell">{formatNumber(row.output)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{formatCost(row.cost)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {pages > 1 && (
                  <nav aria-label="Pages" className="flex items-center justify-end gap-2 border-t px-3 py-2 text-sm">
                    <span className="text-muted-foreground mr-2">Page {shownPage + 1} of {pages}</span>
                    <Button size="sm" variant="outline" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>
                      <ChevronLeft />Previous
                    </Button>
                    <Button size="sm" variant="outline" disabled={shownPage >= pages - 1} onClick={() => setPage(shownPage + 1)}>
                      Next<ChevronRight />
                    </Button>
                  </nav>
                )}
              </>
            )}
          </div>
          <p className="text-muted-foreground mt-3 text-xs">
            Days are UTC. Check <Link to="billing" className="underline underline-offset-4">Billing</Link> for your prepaid credit balance and ledger activity.
          </p>
        </>
      )}
    </>
  );
}
