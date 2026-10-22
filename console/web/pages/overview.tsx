import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { ErrorAlert, PageHeader, Stats } from "@/components/common";
import { ScopeCrumb, scopeName } from "@/components/workspace-ui";
import { formatAgo, formatCost, formatNumber, formatTime, useApi, useApiPage, type AgentSummary, type Billing, type Usage } from "@/lib/api";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useWorkspace, useWorkspaceDirectory } from "@/lib/workspace";

const DAYS = 30;
/** A UTC day (YYYY-MM-DD), `back` days before `now`'s: usage is kept by UTC day. */
export const utcDay = (now: number, back = 0) => new Date(now - back * 86_400_000).toISOString().slice(0, 10);

/**
 * The selection's last 30 days against the 30 before, from one 60-day usage read: spend, each day's spend (oldest
 * first, a zero for a day without any), spend by model or tool, and today's responses.
 */
export function summarize(usage: Usage, now = Date.now()) {
  const first = utcDay(now, DAYS - 1), priorFirst = utcDay(now, 2 * DAYS - 1), today = utcDay(now);
  const daily = new Map(Array.from({ length: DAYS }, (_, at) => [utcDay(now, DAYS - 1 - at), 0]));
  const models = new Map<string, number>();
  let spend = 0, prior = 0, responsesToday = 0;
  for (const row of usage.days ?? []) {
    if (row.day >= first) {
      spend += row.cost;
      daily.set(row.day, (daily.get(row.day) ?? 0) + row.cost);
      const label = row.kind === "turn" ? row.model : `${row.kind} · ${row.model}`;
      models.set(label, (models.get(label) ?? 0) + row.cost);
    } else if (row.day >= priorFirst) prior += row.cost;
    if (row.day === today) responsesToday += row.responses;
  }
  return {
    spend, prior, responsesToday,
    daily: [...daily].map(([day, cost]) => ({ day, cost })),
    models: [...models].map(([model, cost]) => ({ model, cost })).filter(row => row.cost > 0).sort((a, b) => b.cost - a.cost),
  };
}

/** "↑ 12% vs prior 30 days", or nothing to compare with. */
function change(spend: number, prior: number) {
  if (prior <= 0) return spend > 0 ? "no spend the 30 days before" : undefined;
  const percent = Math.round(((spend - prior) / prior) * 100);
  return `${percent > 0 ? "↑" : percent < 0 ? "↓" : "±"} ${Math.abs(percent)}% vs prior 30 days`;
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
          extra: summary && <p className="text-muted-foreground mt-1 text-xs">{[scope && accountSpend ? `${Math.round((summary.spend / accountSpend) * 100)}% of account` : undefined, change(summary.spend, summary.prior)].filter(Boolean).join(" · ")}</p> },
        { label: "Running now", value: running.items ? more(running, running.items.length) : "…",
          extra: <p className="text-muted-foreground mt-1 text-xs">{agents.items ? `of ${more(agents, agents.items.length)} agents` : ""}{busy ? ` · ${busy.limit} busy at most` : ""}</p> },
        { label: "Responses today", value: summary ? formatNumber(summary.responsesToday) : "…",
          extra: failing.items && <p className={cn("mt-1 text-xs", failures.length ? "text-destructive" : "text-muted-foreground")}>{failures.length ? `${more(failing, failures.length)} agent${failures.length === 1 ? "" : "s"} failed · 24h` : "no failures · 24h"}</p> },
        { label: "Agents", value: agents.items ? more(agents, agents.items.length) : "…",
          extra: <p className="text-muted-foreground mt-1 text-xs"><Link to="agents" className="text-foreground underline underline-offset-4">All agents</Link></p> },
      ]} />

      <div className="mb-5 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Panel title="Daily spend" action={<Link to="usage" className="inline-flex items-center gap-1 text-sm underline underline-offset-4">Usage<ArrowRight className="size-3.5" /></Link>}>
          {!summary ? <Skeleton className="h-44 w-full" /> : <DailySpend daily={summary.daily} />}
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

/** Plain bars, one per UTC day, scaled to the largest; each has its date and spend for a screen reader and a hover. */
function DailySpend({ daily }: { daily: { day: string; cost: number }[] }) {
  const max = Math.max(...daily.map(row => row.cost), 0);
  const width = 560, height = 160, step = width / daily.length;
  return (
    <figure>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label={`Daily spend, ${daily[0].day} to ${daily.at(-1)!.day}`}>
        <line x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--border)" />
        {daily.map((row, at) => {
          const barHeight = max > 0 ? Math.max(row.cost > 0 ? 2 : 0, (row.cost / max) * (height - 4)) : 0;
          return <rect key={row.day} x={at * step + step * 0.15} width={step * 0.7} y={height - barHeight} height={barHeight} fill="var(--chart-3)"><title>{`${row.day}: ${formatCost(row.cost)}`}</title></rect>;
        })}
      </svg>
      <figcaption className="text-muted-foreground mt-1.5 flex justify-between font-mono text-xs"><span>{daily[0].day}</span><span>{daily.at(-1)!.day}</span></figcaption>
    </figure>
  );
}
