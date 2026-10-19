import type { AdminTopAgent, AdminUsage, AdminUsageAccount } from "../../../../src/admin-usage";
import { ago, count, fullDay, micros, modelName, percent, useOps, type OpsRange } from "@/lib/ops";
import { ColumnChart, dayColumn, FOCUS, HBars, INK, MID, type BarItem } from "./charts";
import { DataTable, Empty, KindBadge, Panel, Ready, Section, Stat, Stats, TableView, type Column } from "./parts";

/**
 * Usage: who uses camelRun, and how. Self-serve accounts by default; `everyone` adds camelBot and the other admin
 * tenants, accounts an operator made, and the team's own, from the same answer (the self_serve_* figures or the totals).
 */
export function UsageTab({ days, refresh, everyone, onAccount }: { days: OpsRange; refresh: number; everyone: boolean; onAccount: (tenant: string) => void }) {
  const usage = useOps<AdminUsage>(`/api/usage?days=${days}`, refresh);
  const data = usage.data;
  const who = everyone ? "Every account" : "Self-serve accounts";
  const before = `vs the ${days} days before`;
  const agents = data && perAgent(data);
  return (
    <>
      <div className="mb-10">
        <Ready state={usage.state}>
          {data && (
            <Stats columns={5}>
              <Stat label="Active accounts" value={count(data.tiles.active_accounts.current)} compare={data.tiles.active_accounts} compareLabel={before}
                hint="Self-serve accounts whose agents got at least one model answer in the range (always self-serve: the team and camelBot are not people signing up)." />
              <Stat label="Model responses" value={count((everyone ? data.tiles.responses : data.tiles.self_serve_responses).current)}
                compare={everyone ? data.tiles.responses : data.tiles.self_serve_responses} compareLabel={before}
                hint="Answers a model gave to agents' turns. Web searches, compactions, voice and images are not counted." />
              <Stat label="Agents that ran" value={agents!.recorded ? count((everyone ? data.tiles.agents_ran : data.tiles.self_serve_agents_ran).current) : "—"}
                compare={agents!.comparable ? (everyone ? data.tiles.agents_ran : data.tiles.self_serve_agents_ran) : agents!.recorded ? null : undefined} compareLabel={before}
                detail={agents!.note}
                hint="Different agents a model answered in the range, stateless runs and sub-agents included." />
              <Stat label="End users reached" value={agents!.recorded ? count((everyone ? data.tiles.end_users : data.tiles.self_serve_end_users).current) : "—"}
                compare={agents!.recorded ? (agents!.comparable ? (everyone ? data.tiles.end_users : data.tiles.self_serve_end_users) : null) : undefined} compareLabel={before}
                detail={agents!.note}
                hint="The people behind calls metered by end-user credits: how camelBot meters its members, through an agent's subject. An agent that does not meter its own users counts none, so this is not every user of every agent." />
              <Stat label="Live agents" value={count(everyone ? data.tiles.live_agents : data.tiles.self_serve_live_agents)} detail="Right now"
                hint="Agents that exist now: not deleted or expired, and not a stateless run's session or a sub-agent." />
            </Stats>
          )}
        </Ready>
      </div>

      <Section title="How much they use it" description={`${who}, by UTC day. Today is still going.`}>
        <Panel title="Model responses per day" state={usage.state}
          hint={everyone ? "camelBot & operators: admin tenants of the runtime. Other accounts: ones an operator made, the team's own, and erased ones." : undefined}>
          {data && <ResponsesChart data={data} everyone={everyone} />}
        </Panel>
      </Section>

      <Section title="Which models" description={`${who}. What agents ran in the range, and what live agents are set to now.`}>
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Models people run" description="Model responses in the range" state={usage.state}>
            {data && <ModelsRun data={data} everyone={everyone} />}
          </Panel>
          <Panel title="Models agents are set to" description="Live agents now, by the model they use" state={usage.state}>
            {data && <ModelsSet data={data} everyone={everyone} />}
          </Panel>
        </div>
      </Section>

      <Section title="What they build with" description={`${who}. Tools live agents have, and what accounts connected.`}>
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="What agents use" description="Share of live agents with each" state={usage.state}>
            {data && <Features data={data} everyone={everyone} />}
          </Panel>
          <Panel title="What accounts set up" description="Accounts with each, ever" state={usage.state}>
            {data && <Integrations data={data} everyone={everyone} />}
          </Panel>
        </div>
      </Section>

      <Section title="Who uses it most" description={`${who}, the most model responses in the range first. Open one to see its agents and how they are set up.`}>
        <div className="grid gap-4">
          <Panel title="Top accounts" flush state={usage.state} hint="The 100 accounts with the most model responses in the range, of every kind; the switch above hides the ones that are not self-serve.">
            {data && <TopAccounts rows={data.accounts.filter(row => everyone || (row.kind === "self_serve" && !row.staff))} onAccount={onAccount} />}
          </Panel>
          <Panel title="Most used agents" flush state={usage.state} hint="The 25 agents with the most model responses in the range, of every kind of account."
            description={agents?.note && `Per-agent figures ${agents.recorded ? `start ${fullDay(data!.attempts_since!)}` : "are not recorded yet"}: the runtime keeps them since release 0.10.0.`}>
            {data && <TopAgents rows={data.agents.filter(row => everyone || (row.account.kind === "self_serve" && !row.account.staff))} onAccount={onAccount} />}
          </Panel>
        </div>
      </Section>
    </>
  );
}

/**
 * Whether the range's per-agent figures (agents that ran, end users, most used agents) are whole: the runtime keeps them
 * from `attempts_since` on. A range that starts before then counts from then, and a period before it has nothing to compare.
 */
function perAgent(data: AdminUsage) {
  const since = data.attempts_since?.slice(0, 10) ?? null;
  return {
    recorded: since !== null,
    comparable: since !== null && since <= data.range.previous_start_date,
    note: since === null ? "Not recorded yet" : since > data.range.start_date ? `Counted from ${fullDay(since)}` : undefined,
  };
}

function ResponsesChart({ data, everyone }: { data: AdminUsage; everyone: boolean }) {
  const series = everyone
    ? [{ key: "self_serve", label: "Self-serve", color: FOCUS }, { key: "operator", label: "camelBot & operators", color: INK }, { key: "other", label: "Other accounts", color: MID }]
    : [{ key: "self_serve", label: "responses", color: FOCUS }];
  const total = data.daily.reduce((sum, row) => sum + row.self_serve + (everyone ? row.operator + row.other : 0), 0);
  return (
    <>
      {!everyone && <p className="text-muted-foreground mb-3 text-xs"><span className="text-foreground font-mono">{count(total)}</span> self-serve responses in {data.daily.length} days</p>}
      <ColumnChart label={`Model responses per day: ${count(total)} in ${data.daily.length} days`} series={series}
        table={everyone ? undefined : { columns: ["Day (UTC)", "Responses"], rows: [...data.daily].reverse().map(row => [dayColumn(row.date, data.range.incomplete_date).title, row.self_serve]) }}
        data={data.daily.map(row => ({ ...dayColumn(row.date, data.range.incomplete_date), values: everyone ? [row.self_serve, row.operator, row.other] : [row.self_serve] }))} />
    </>
  );
}

/** A model's name with where it is reached through under it, muted. */
const modelLabel = (model: string) => {
  const { name, via } = modelName(model);
  return { label: name, sub: via || undefined, text: model };
};

function ModelsRun({ data, everyone }: { data: AdminUsage; everyone: boolean }) {
  const items: BarItem[] = data.models
    .map(row => ({ row, value: everyone ? row.responses : row.self_serve_responses, accounts: everyone ? row.accounts : row.self_serve_accounts }))
    .filter(entry => entry.value > 0).sort((a, b) => b.value - a.value)
    .map(({ row, value, accounts }) => ({ key: row.model, ...modelLabel(row.model), value, extra: [{ value: count(accounts), label: accounts === 1 ? "account" : "accounts" }] }));
  return (
    <>
      <HBars label="Model responses by model" unit="responses" columns={["Responses", "Accounts"]} items={items} empty={<Empty>No model answered an agent in this range.</Empty>} />
      {items.length > 0 && <TableView columns={["Model", "Responses", "Accounts"]} rows={items.map(item => [item.text, item.value, item.extra![0].value])} />}
    </>
  );
}

function ModelsSet({ data, everyone }: { data: AdminUsage; everyone: boolean }) {
  const items: BarItem[] = data.configured_models
    .map(row => ({ row, value: everyone ? row.agents : row.self_serve_agents, accounts: everyone ? row.accounts : row.self_serve_accounts }))
    .filter(entry => entry.value > 0).sort((a, b) => b.value - a.value)
    .map(({ row, value, accounts }) => ({ key: row.model, ...modelLabel(row.model), value, extra: [{ value: count(accounts), label: accounts === 1 ? "account" : "accounts" }] }));
  return (
    <>
      <HBars label="Live agents by model" unit="agents" columns={["Agents", "Accounts"]} items={items} empty={<Empty>No live agents.</Empty>} />
      {items.length > 0 && <TableView columns={["Model", "Agents", "Accounts"]} rows={items.map(item => [item.text, item.value, item.extra![0].value])} />}
    </>
  );
}

function Features({ data, everyone }: { data: AdminUsage; everyone: boolean }) {
  const live = everyone ? data.tiles.live_agents : data.tiles.self_serve_live_agents;
  if (!live) return <Empty>No live agents yet.</Empty>;
  const items: BarItem[] = data.features
    .map(feature => ({ feature, value: everyone ? feature.agents : feature.self_serve_agents }))
    .sort((a, b) => b.value - a.value)
    .map(({ feature, value }) => ({ key: feature.key, label: feature.label, text: feature.label, value, extra: [{ value: count(value), label: value === 1 ? "agent" : "agents" }] }));
  return (
    <>
      <HBars label="Share of live agents with each feature" unit={`of ${count(live)} live agents`} max={live} format={value => percent(value, live)} columns={["Share", "Agents"]} items={items} />
      <TableView columns={["Feature", "Agents", "Share of live agents"]} rows={items.map(item => [item.text, item.value, percent(item.value, live)])} />
    </>
  );
}

function Integrations({ data, everyone }: { data: AdminUsage; everyone: boolean }) {
  const items: BarItem[] = data.integrations
    .map(entry => ({ entry, value: everyone ? entry.accounts : entry.self_serve_accounts }))
    .filter(item => item.value > 0).sort((a, b) => b.value - a.value)
    .map(({ entry, value }) => ({ key: entry.key, label: entry.label, text: entry.label, value }));
  return (
    <>
      <HBars label="Accounts that set up each" unit="accounts" items={items} empty={<Empty>No account has connected anything yet.</Empty>} />
      {items.length > 0 && <TableView columns={["What they set up", "Accounts"]} rows={items.map(item => [item.text, item.value])} />}
      <div className="mt-4 border-t pt-3.5 text-xs">
        <p className="text-muted-foreground mb-1.5">MCP clients connected <span className="text-muted-foreground">(every account)</span></p>
        {data.mcp_clients.length ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {data.mcp_clients.map(client => <li key={client.client}>{client.client} <span className="text-muted-foreground font-mono tabular-nums">{count(client.accounts)}</span></li>)}
          </ul>
        ) : <p className="text-muted-foreground">None yet.</p>}
      </div>
    </>
  );
}

function AccountCell({ name, kind, staff, deleted }: { name: string; kind: AdminUsageAccount["kind"]; staff: boolean; deleted?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="max-w-48 truncate font-medium" title={name}>{name}</span>
      {(kind !== "self_serve" || staff) && <KindBadge kind={kind} staff={staff} />}
      {deleted && <span className="text-muted-foreground">erased</span>}
    </span>
  );
}

function TopAccounts({ rows, onAccount }: { rows: AdminUsageAccount[]; onAccount: (tenant: string) => void }) {
  const columns: Column<AdminUsageAccount>[] = [
    { key: "name", label: "Account", cell: row => <AccountCell name={row.name} kind={row.kind} staff={row.staff} deleted={row.deleted} />, sort: row => row.name.toLowerCase() },
    { key: "signed_up", label: "Signed up", cell: row => row.signed_up_at ? fullDay(row.signed_up_at) : "—", sort: row => row.signed_up_at ? Date.parse(row.signed_up_at) : 0 },
    { key: "agents", label: "Agents", align: "right", cell: row => count(row.agents), sort: row => row.agents, hint: "Live agents now" },
    { key: "responses", label: "Responses", align: "right", cell: row => count(row.responses), sort: row => row.responses },
    { key: "active_days", label: "Active days", align: "right", cell: row => count(row.active_days), sort: row => row.active_days },
    { key: "last_active", label: "Last active", cell: row => ago(row.last_active), sort: row => row.last_active ?? "" },
    { key: "models", label: "Top models", cell: row => <span className="text-muted-foreground block max-w-40 truncate" title={row.models.join(", ")}>{row.models.map(model => modelName(model).name).join(", ") || "—"}</span> },
    { key: "balance", label: "Credit left", align: "right", cell: row => row.balance === null ? "—" : micros(row.balance), sort: row => row.balance ?? -Infinity },
  ];
  return <DataTable rows={rows} columns={columns} rowKey={row => row.tenant} initialSort="responses" search={row => `${row.name} ${row.tenant}`} searchLabel="Find an account" onOpen={row => onAccount(row.tenant)}
    empty={<Empty>No account got a model response in this range.</Empty>} />;
}

function TopAgents({ rows, onAccount }: { rows: AdminTopAgent[]; onAccount: (tenant: string) => void }) {
  const kinds = { agent: "", run: "stateless run", child: "sub-agent" } as const;
  const columns: Column<AdminTopAgent>[] = [
    { key: "name", label: "Agent", sort: row => row.name.toLowerCase(), cell: row => (
      <span className="flex items-center gap-2"><span className="max-w-52 truncate font-medium" title={row.agent}>{row.name}</span>
        {(row.kind !== "agent" || row.deleted) && <span className="text-muted-foreground">{[kinds[row.kind], row.deleted ? "deleted" : ""].filter(Boolean).join(", ")}</span>}</span>
    ) },
    { key: "account", label: "Account", sort: row => row.account.name.toLowerCase(), cell: row => <AccountCell name={row.account.name} kind={row.account.kind} staff={row.account.staff} /> },
    { key: "model", label: "Model", cell: row => <span title={row.model}>{row.model ? modelName(row.model).name : "—"}</span>, sort: row => row.model },
    { key: "responses", label: "Responses", align: "right", cell: row => count(row.responses), sort: row => row.responses },
    { key: "end_users", label: "End users", align: "right", cell: row => count(row.end_users), sort: row => row.end_users, hint: "Different people it answered for" },
    { key: "active_days", label: "Active days", align: "right", cell: row => count(row.active_days), sort: row => row.active_days },
    { key: "last_at", label: "Last run", cell: row => ago(row.last_at), sort: row => row.last_at },
  ];
  return <DataTable rows={rows} columns={columns} rowKey={row => `${row.account.tenant}/${row.agent}`} initialSort="responses" onOpen={row => onAccount(row.account.tenant)}
    empty={<Empty>No agent got a model response in this range.</Empty>} />;
}
