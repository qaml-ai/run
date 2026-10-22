import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { ErrorAlert, PageHeader, Stats } from "@/components/common";
import { ScopeCrumb, scopeName } from "@/components/workspace-ui";
import { formatAgo, formatCost, formatNumber, formatTime, useApi, useApiPage, type AgentSummary, type Billing, type Usage } from "@/lib/api";
import { Link } from "@/lib/router";
import { changeLabel, summarizeUsage } from "@/lib/usage";
import { DailyBars } from "@/components/charts";
import { cn } from "@/lib/utils";
import { useWorkspace, useWorkspaceDirectory } from "@/lib/workspace";

const DAYS = 30;
/** The last 30 days of a 60-day usage read (`summarizeUsage`), with its spend as `spend`. */
export function summarize(usage: Usage, now = Date.now()) {
  const summary = summarizeUsage(usage, DAYS, now);
  return { ...summary, spend: summary.totals.cost };
}

/**
 * Home for an account with agents: what the selected workspace (or the whole account) is doing and spending. Reads the
 * usage API (60 days, for the comparison) and GET /v1/agents' filters; failures are each agent's latest (class and time).
 */
export function OverviewPage({ billing }: { billing?: Billing }) {
  const { ws } = useWorkspace();
  const directory = useWorkspaceDirectory();
  const scope = directory.workspaces?.length ? ws : undefined;
  const filter = scope ? `&workspaceId=${encodeURIComponent(scope)}` : "";
  // Read once the scope is known (whether the account has workspaces at all), so nothing is read twice.
  const ready = directory.loaded || !!directory.error;
  const read = (path: string) => ready ? path : undefined;
  const usage = useApi<Usage>(read(`/v1/usage?days=${2 * DAYS}${filter}`));
  // The account's own 30 days, for the selection's share of it.
  const account = useApi<Usage>(scope ? read(`/v1/usage?days=${DAYS}`) : undefined);
  const agents = useApiPage<AgentSummary>(read(`/v1/agents?limit=200${filter}`), 30_000);
  const running = useApiPage<AgentSummary>(read(`/v1/agents?status=running&limit=50${filter}`), 10_000);
  const failing = useApiPage<AgentSummary>(read(`/v1/agents?status=failed&limit=50${filter}`), 30_000);
  const summary = usage.data ? summarize(usage.data) : undefined;
  const name = scopeName(directory, scope);
  const failures = [...(failing.items ?? [])].sort((a, b) => b.lastError!.at - a.lastError!.at);
  const accountSpend = account.data ? account.data.totals.cost : undefined;
  const more = (page: { next?: string }, count: number) => `${count}${page.next ? "+" : ""}`;
  const busy = billing?.busyAgents;

  return (
    <>
      <ScopeCrumb directory={directory} />
      <PageHeader title="Overview" description={`What ${name ? `${name} is` : "your agents are"} doing and spending. Last ${DAYS} days.`} />
      <ErrorAlert error={usage.error ?? agents.error ?? running.error ?? failing.error} />
      <Stats items={[
        { label: `Spend · ${DAYS} days`, value: summary ? formatCost(summary.spend) : "…",
          extra: summary && <p className="text-muted-foreground mt-1 text-xs">{[scope && accountSpend ? `${Math.round((summary.spend / accountSpend) * 100)}% of account` : undefined, changeLabel(summary.spend, summary.prior, DAYS)].filter(Boolean).join(" · ")}</p> },
        { label: "Running now", value: running.items ? more(running, running.items.length) : "…",
          extra: <p className="text-muted-foreground mt-1 text-xs">{agents.items ? `of ${more(agents, agents.items.length)} agents` : ""}{busy ? ` · ${busy.limit} busy at most` : ""}</p> },
        { label: "Responses today", value: summary ? formatNumber(summary.responsesToday) : "…",
          extra: failing.items && <p className={cn("mt-1 text-xs", failures.length ? "text-destructive" : "text-muted-foreground")}>{failures.length ? `${more(failing, failures.length)} agent${failures.length === 1 ? "" : "s"} failed · 24h` : "no failures · 24h"}</p> },
        { label: "Agents", value: agents.items ? more(agents, agents.items.length) : "…",
          extra: <p className="text-muted-foreground mt-1 text-xs"><Link to="agents" className="text-foreground underline underline-offset-4">All agents</Link></p> },
      ]} />

      <div className="mb-5 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Panel title="Daily spend" action={<Link to="usage" className="inline-flex items-center gap-1 text-sm underline underline-offset-4">Usage<ArrowRight className="size-3.5" /></Link>}>
          {!summary ? <Skeleton className="h-44 w-full" /> : summary.spend <= 0 ? <p className="text-muted-foreground text-sm">No spend in the last {DAYS} days.</p> : <DailyBars days={summary.days} series={[{ label: "Spend", look: { kind: "ramp", index: 0 }, values: summary.daily.map(row => row.cost) }]} />}
        </Panel>
        <Panel title="By model and tool">
          {!summary ? <Skeleton className="h-44 w-full" /> : summary.models.length === 0 ? <p className="text-muted-foreground text-sm">No spend in the last {DAYS} days.</p> : (
            <div className="flex flex-col gap-3.5">
              {summary.models.slice(0, 6).map(row => (
                <div key={row.model}>
                  <div className="flex justify-between gap-3 font-mono text-xs"><span className="min-w-0 truncate">{row.model}</span><span className="tabular-nums">{formatCost(row.cost)}</span></div>
                  <div className="bg-chart-4 mt-1.5 h-2" aria-hidden="true"><div className="bg-chart-3 h-full" style={{ width: `${Math.max(1, Math.round((row.cost / summary.spend) * 100))}%` }} /></div>
                </div>
              ))}
              {summary.models.length > 6 && <p className="text-muted-foreground text-xs">and {summary.models.length - 6} more on <Link to="usage" className="underline underline-offset-4">Usage</Link></p>}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Panel flush title="Needs attention" action={<span className="text-muted-foreground text-xs">latest failure per agent · 24h</span>}>
          {!failing.items ? <Skeleton className="m-4 h-16" /> : failures.length === 0 ? <p className="text-muted-foreground px-4 py-3 text-sm">Nothing failed in the last 24 hours.</p> : (
            <Table><TableBody>{failures.slice(0, 8).map(agent => (
              <TableRow key={agent.id}>
                <TableCell className="w-0"><Badge variant="destructive">Failed</Badge></TableCell>
                <TableCell className="max-w-48 truncate"><Link to={`agents/${agent.id}`} className="font-medium underline underline-offset-4">{agent.name}</Link></TableCell>
                <TableCell className="text-muted-foreground hidden font-mono text-xs sm:table-cell">{agent.lastError!.class.replace(/_/g, " ")}</TableCell>
                <TableCell className="text-muted-foreground text-right text-sm" title={formatTime(agent.lastError!.at)}>{formatAgo(agent.lastError!.at)}</TableCell>
              </TableRow>
            ))}</TableBody></Table>
          )}
          {failures.length > 8 && <p className="border-t px-4 py-2 text-sm"><Link to="agents" className="underline underline-offset-4">All failing agents in Agents</Link></p>}
        </Panel>
        <Panel flush title="Running now" action={<Link to="agents" className="inline-flex items-center gap-1 text-sm underline underline-offset-4">All agents<ArrowRight className="size-3.5" /></Link>}>
          {!running.items ? <Skeleton className="m-4 h-16" /> : running.items.length === 0 ? <p className="text-muted-foreground px-4 py-3 text-sm">No agent is loaded right now.</p> : (
            <Table><TableBody>{running.items.slice(0, 8).map(agent => (
              <TableRow key={agent.id}>
                <TableCell className="w-0"><Badge variant="live">Running</Badge></TableCell>
                <TableCell className="max-w-48 truncate"><Link to={`agents/${agent.id}`} className="font-medium hover:underline underline-offset-4">{agent.name}</Link></TableCell>
                <TableCell className="text-muted-foreground hidden max-w-40 truncate text-right font-mono text-xs sm:table-cell">{agent.model}</TableCell>
              </TableRow>
            ))}</TableBody></Table>
          )}
        </Panel>
      </div>
    </>
  );
}

function Panel({ title, action, children, flush }: { title: string; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="bg-card min-w-0 border" aria-label={title}>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3"><h2 className="text-sm font-semibold">{title}</h2>{action}</div>
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}
