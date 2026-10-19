import type { AdminCheck, AdminHealth, AdminNode, AdminPayer, AdminSpendAccount } from "../../../../src/admin-health";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { compact, count, month, percent, plural, usd, useOps, type OpsRange } from "@/lib/ops";
import { ColumnChart, dayColumn, FOCUS, HBars, INK, MID, type BarItem } from "./charts";
import { DataTable, Empty, KindBadge, Panel, Ready, Section, Stat, Stats, StatusMark, type Column } from "./parts";

const COST_EXPLORER = "https://us-east-1.console.aws.amazon.com/cost-management/home";
const dollarTick = (value: number) => `$${compact(value)}`;

const PAYERS: Record<AdminPayer, { label: string; hint: string }> = {
  paying: { label: "Paying accounts", hint: "Accounts that bought credit" },
  free: { label: "On free credit", hint: "Accounts that never bought credit" },
  operator: { label: "camelBot & operators", hint: "Admin tenants of the runtime" },
  unbilled: { label: "Not charged", hint: "Made before billing, or set so" },
  staff: { label: "Team", hint: "The team's own accounts" },
};

/**
 * Health: is the system healthy, and what does it spend? `everyone` off leaves camelBot, the other operators and the
 * team out of who the spend was for; the totals stay the platform's.
 */
export function HealthTab({ days, refresh, everyone, onAccount }: { days: OpsRange; refresh: number; everyone: boolean; onAccount: (tenant: string) => void }) {
  const health = useOps<AdminHealth>(`/api/health?days=${days}`, refresh);
  const data = health.data;
  const spend = data?.spend;
  const payerTotal = spend ? Object.values(spend.by_payer).reduce((sum, value) => sum + value, 0) : 0;
  return (
    <>
      <div className="mb-10">
        <Ready state={health.state}>
          {spend && data && (
            <Stats>
              <Stat label={`Spend, last ${days} days`} value={usd(spend.window.current)} compare={spend.window} compareLabel={`vs the ${days} days before`} upIsBad
                hint="What the platform paid model and tool providers for calls on its own keys, OpenRouter's fee included. Calls on accounts' own keys are theirs." />
              <Stat label="This month so far" value={usd(spend.month_to_date)} detail={`On pace for ${usd(spend.month_projection)}`}
                hint="Since the 1st (UTC). The pace is the month through yesterday plus the last 7 whole days' average for each day left." />
              <Stat label="Last month" value={usd(spend.last_month)} detail={month(lastMonth(data.range.end_date), true)} />
              <Stat label="Spent on free credit" value={percent(spend.by_payer.free, payerTotal)} detail={`${usd(spend.by_payer.free)} in ${days} days`}
                hint="The share of the spend that was for accounts that never bought credit." />
            </Stats>
          )}
        </Ready>
      </div>

      <Section title="What we spend"
        hint={<>Only model and tool providers&rsquo; charges. AWS (servers, the database, storage) is not in the runtime&rsquo;s database: see it in{" "}
          <a href={COST_EXPLORER} target="_blank" rel="noreferrer" className="underline underline-offset-2">AWS Cost Explorer</a>.</>}
        description={spend ? <>Paid to model and tool providers on our keys, by UTC day. {plural(spend.own_key_responses, "response")} ran on accounts&rsquo; own keys: not our spend.</> : "Paid to model and tool providers on our keys, by UTC day."}>
        <div className="grid gap-4">
          <Panel title="Spend per day" state={health.state}>{data && <SpendChart data={data} />}</Panel>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Who the spend was for" description={everyone ? "Every account" : "camelBot, operators and the team left out"} state={health.state}>
              {spend && <Payers spend={spend} everyone={everyone} />}
            </Panel>
            <Panel title="By provider" description="Where the money went" state={health.state}>
              {spend && <Providers spend={spend} />}
            </Panel>
          </div>
          <Panel title="Top spenders" flush state={health.state} hint="The 10 accounts whose calls cost the platform the most in the range. Open one to see its agents.">
            {spend && <TopSpenders rows={spend.top_accounts.filter(row => everyone || (row.kind === "self_serve" && row.payer !== "staff"))} onAccount={onAccount} />}
          </Panel>
        </div>
      </Section>

      <Section title="System checks" description="Queues and jobs that should stay quiet: work waiting longer than it should is the sign of a fault. Problems first.">
        <div className="grid gap-4">
          <Panel title="Checks" flush state={health.state}>{data && <Checks checks={data.checks} />}</Panel>
          <Panel title="Runtime nodes" flush state={health.state} hint="The servers running agents now, and how many agents each holds.">{data && <Nodes nodes={data.nodes} />}</Panel>
        </div>
      </Section>
    </>
  );
}

const lastMonth = (end: string) => {
  const date = new Date(`${end.slice(0, 7)}-15T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
};

function SpendChart({ data }: { data: AdminHealth }) {
  const series = [
    { key: "models", label: "Model calls", color: FOCUS },
    { key: "search", label: "Web & tool search", color: INK },
    { key: "media", label: "Voice & images", color: MID },
  ];
  const rows = data.spend.daily.map(row => ({ row, values: [row.models + row.compaction, row.web + row.tool_search, row.voice + row.images] }));
  return (
    <ColumnChart label={`Spend per day in dollars, ${usd(data.spend.window.current)} in ${data.spend.daily.length} days`} series={series} format={usd} axis={dollarTick} least={0.01}
      data={rows.map(({ row, values }) => ({ ...dayColumn(row.date, data.range.incomplete_date), values }))} />
  );
}

function Payers({ spend, everyone }: { spend: AdminHealth["spend"]; everyone: boolean }) {
  const shown = (Object.keys(PAYERS) as AdminPayer[]).filter(payer => everyone || (payer !== "operator" && payer !== "staff"));
  const total = shown.reduce((sum, payer) => sum + spend.by_payer[payer], 0);
  if (!total) return <Empty>Nothing was spent on these accounts in this range.</Empty>;
  const items: BarItem[] = shown.map(payer => ({
    key: payer, label: PAYERS[payer].label, text: PAYERS[payer].label, sub: PAYERS[payer].hint, value: spend.by_payer[payer],
    extra: [{ value: percent(spend.by_payer[payer], total), label: "of it" }],
  }));
  return <HBars label="Spend by whose calls it was" unit="spent" format={usd} columns={["Spent", "Share"]} items={items} />;
}

function Providers({ spend }: { spend: AdminHealth["spend"] }) {
  if (!spend.by_provider.length) return <Empty>No provider was paid in this range.</Empty>;
  const items: BarItem[] = spend.by_provider.map(row => ({
    key: row.provider, label: row.provider, text: row.provider, value: row.cost, extra: [{ value: compact(row.responses), label: "calls" }],
  }));
  return <HBars label="Spend by provider" unit="spent" format={usd} columns={["Spent", "Calls"]} items={items} />;
}

function TopSpenders({ rows, onAccount }: { rows: AdminSpendAccount[]; onAccount: (tenant: string) => void }) {
  const columns: Column<AdminSpendAccount>[] = [
    { key: "name", label: "Account", sort: row => row.name.toLowerCase(), cell: row => (
      <span className="flex items-center gap-2"><span className="max-w-56 truncate font-medium" title={row.name}>{row.name}</span>
        {(row.kind !== "self_serve" || row.payer === "staff") && <KindBadge kind={row.kind} staff={row.payer === "staff"} />}</span>
    ) },
    { key: "payer", label: "Whose spend", cell: row => PAYERS[row.payer].label, sort: row => row.payer },
    { key: "responses", label: "Calls on our keys", align: "right", cell: row => count(row.responses), sort: row => row.responses },
    { key: "cost", label: "Spent", align: "right", cell: row => usd(row.cost), sort: row => row.cost },
  ];
  return <DataTable rows={rows} columns={columns} rowKey={row => row.tenant} initialSort="cost" onOpen={row => onAccount(row.tenant)} empty={<Empty>Nothing was spent in this range.</Empty>} />;
}

const ORDER: Record<AdminCheck["status"], number> = { bad: 0, warn: 1, ok: 2, info: 3 };

function Checks({ checks }: { checks: AdminCheck[] }) {
  const sorted = [...checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  return (
    <ul className="border-t">
      {sorted.map(check => (
        <li key={check.key} className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 border-b px-4 py-2.5 text-xs last:border-b-0 sm:grid-cols-[5.5rem_minmax(0,12rem)_minmax(0,13rem)_minmax(0,1fr)]">
          <StatusMark status={check.status} />
          <span className="font-medium">{check.label}</span>
          <span className="col-start-2 font-mono sm:col-start-auto">{check.value}</span>
          <span className="text-muted-foreground col-start-2 sm:col-start-auto">{check.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function Nodes({ nodes }: { nodes: AdminNode[] }) {
  if (!nodes.length) return <Empty>No runtime node holds a lease right now.</Empty>;
  return (
    <div className="overflow-x-auto border-t">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="h-9">Node</TableHead>
            <TableHead className="h-9 text-right">Agents held</TableHead>
            <TableHead className="h-9">State</TableHead>
            <TableHead className="h-9 text-right">Lease ends in</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {nodes.map(node => (
            <TableRow key={node.node}>
              <TableCell className="font-mono text-xs">{node.node}</TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums">{count(node.actors)}</TableCell>
              <TableCell className="text-xs">{node.draining ? "Draining (a deploy is rolling)" : "Taking work"}</TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums">{node.expires_in_s < 120 ? `${node.expires_in_s} s` : `${count(Math.round(node.expires_in_s / 60))} min`}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
