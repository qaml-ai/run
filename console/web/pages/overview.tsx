import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { ErrorAlert, PageHeader, Stats } from "@/components/common";
import { DailyBars } from "@/components/charts";
import {
  formatAgo,
  formatCost,
  formatNumber,
  formatTime,
  formatUsd,
  useApi,
  type AgentSummary,
  type Billing,
  type UsageResponse,
} from "@/lib/api";
import { Link } from "@/lib/router";
import { changeLabel, summarizeUsage } from "@/lib/usage";

const DAYS = 30;

/** The last 30 days of a 60-day usage read (`summarizeUsage`), with its spend as `spend`. */
export function summarize(usage: UsageResponse, now = Date.now()) {
  const summary = summarizeUsage(usage, DAYS, now);
  return { ...summary, spend: summary.totals.cost };
}

/**
 * Home for an account with agents: what the account is doing and spending across CamelRun v2.
 */
export function OverviewPage({ billing }: { billing?: Billing }) {
  const usage = useApi<UsageResponse>(`/v2/usage?days=${2 * DAYS}`);
  const agentsRes = useApi<{ agents: AgentSummary[] }>("/v2/agents", 10_000);
  const agents = agentsRes.data?.agents;
  const running = agents?.filter(agent => agent.running) ?? [];
  const recent = agents ? [...agents].sort((a, b) => b.updatedAt - a.updatedAt) : undefined;
  const summary = usage.data ? summarize(usage.data) : undefined;
  const busy = billing?.busyAgents;

  return (
    <>
      <PageHeader title="Overview" description={`What your agents are doing and spending. Last ${DAYS} days.`} />
      <ErrorAlert error={usage.error ?? agentsRes.error} />
      <Stats
        items={[
          {
            label: `Spend · ${DAYS} days`,
            value: summary ? formatCost(summary.spend) : "…",
            extra: summary && (
              <p className="text-muted-foreground mt-1 text-xs">
                {changeLabel(summary.spend, summary.prior, DAYS) ?? (billing ? `Balance ${formatUsd(billing.balanceUsd)}` : undefined)}
              </p>
            ),
          },
          {
            label: "Running now",
            value: agents ? String(running.length) : "…",
            extra: (
              <p className="text-muted-foreground mt-1 text-xs">
                {agents ? `of ${agents.length} agent${agents.length === 1 ? "" : "s"}` : ""}
                {busy && busy.limit !== null ? ` · ${busy.limit} busy at most` : ""}
              </p>
            ),
          },
          {
            label: "Responses today",
            value: summary ? formatNumber(summary.responsesToday) : "…",
            extra: billing && (
              <p className="text-muted-foreground mt-1 text-xs">
                Balance <Link to="billing" className="text-foreground underline underline-offset-4">{formatUsd(billing.balanceUsd)}</Link>
              </p>
            ),
          },
          {
            label: "Agents",
            value: agents ? String(agents.length) : "…",
            extra: (
              <p className="text-muted-foreground mt-1 text-xs">
                <Link to="agents" className="text-foreground underline underline-offset-4">All agents</Link>
              </p>
            ),
          },
        ]}
      />

      <div className="mb-5 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Panel
          title="Daily spend"
          action={
            <Link to="usage" className="inline-flex items-center gap-1 text-sm underline underline-offset-4">
              Usage<ArrowRight className="size-3.5" />
            </Link>
          }
        >
          {!summary ? (
            <Skeleton className="h-44 w-full" />
          ) : summary.spend <= 0 ? (
            <p className="text-muted-foreground text-sm">No spend in the last {DAYS} days.</p>
          ) : (
            <DailyBars
              days={summary.days}
              series={[{ label: "Spend", look: { kind: "ramp", index: 0 }, values: summary.daily.map(row => row.cost) }]}
            />
          )}
        </Panel>
        <Panel title="By model">
          {!summary ? (
            <Skeleton className="h-44 w-full" />
          ) : summary.models.length === 0 ? (
            <p className="text-muted-foreground text-sm">No spend in the last {DAYS} days.</p>
          ) : (
            <div className="flex flex-col gap-3.5">
              {summary.models.slice(0, 6).map(row => (
                <div key={row.model}>
                  <div className="flex justify-between gap-3 font-mono text-xs">
                    <span className="min-w-0 truncate">{row.model}</span>
                    <span className="tabular-nums">{formatCost(row.cost)}</span>
                  </div>
                  <div className="bg-chart-4 mt-1.5 h-2" aria-hidden="true">
                    <div
                      className="bg-chart-3 h-full"
                      style={{ width: `${Math.max(1, Math.round((row.cost / summary.spend) * 100))}%` }}
                    />
                  </div>
                </div>
              ))}
              {summary.models.length > 6 && (
                <p className="text-muted-foreground text-xs">
                  and {summary.models.length - 6} more on <Link to="usage" className="underline underline-offset-4">Usage</Link>
                </p>
              )}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Panel
          flush
          title="Recent agents"
          action={
            <Link to="agents" className="inline-flex items-center gap-1 text-sm underline underline-offset-4">
              All agents<ArrowRight className="size-3.5" />
            </Link>
          }
        >
          {!recent ? (
            <Skeleton className="m-4 h-16" />
          ) : recent.length === 0 ? (
            <p className="text-muted-foreground px-4 py-3 text-sm">No agents yet.</p>
          ) : (
            <Table>
              <TableBody>
                {recent.slice(0, 8).map(agent => (
                  <TableRow key={agent.id}>
                    <TableCell className="w-0">
                      {agent.running ? <Badge variant="live">Running</Badge> : <Badge variant="outline">Idle</Badge>}
                    </TableCell>
                    <TableCell className="max-w-48 truncate">
                      <Link to={`agents/${agent.id}`} className="font-medium underline underline-offset-4">
                        {agent.key}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden max-w-44 truncate font-mono text-xs sm:table-cell">
                      {agent.model}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-sm" title={formatTime(agent.updatedAt)}>
                      {formatAgo(agent.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
        <Panel
          flush
          title="Running now"
          action={
            <Link to="agents" className="inline-flex items-center gap-1 text-sm underline underline-offset-4">
              All agents<ArrowRight className="size-3.5" />
            </Link>
          }
        >
          {!agents ? (
            <Skeleton className="m-4 h-16" />
          ) : running.length === 0 ? (
            <p className="text-muted-foreground px-4 py-3 text-sm">No agent is running right now.</p>
          ) : (
            <Table>
              <TableBody>
                {running.slice(0, 8).map(agent => (
                  <TableRow key={agent.id}>
                    <TableCell className="w-0"><Badge variant="live">Running</Badge></TableCell>
                    <TableCell className="max-w-48 truncate">
                      <Link to={`agents/${agent.id}`} className="font-medium hover:underline underline-offset-4">
                        {agent.key}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden max-w-40 truncate text-right font-mono text-xs sm:table-cell">
                      {agent.model}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}

function Panel({ title, action, children, flush }: { title: string; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="bg-card min-w-0 border" aria-label={title}>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}
