import { ShoppingCart } from "lucide-react";
import type { AdminFreeCreditAccount, AdminFreeCreditBucket, AdminRevenue } from "../../../../src/admin-revenue";
import { ago, compact, count, micros, month, percent, plural, usd, useOps, type OpsRange } from "@/lib/ops";
import { ColumnChart, dayColumn, FOCUS, Meter, ORDINAL, SplitBar } from "./charts";
import { cn } from "@/lib/utils";
import { DataTable, Empty, Hint, Panel, Ready, Section, Stat, Stats, type Column } from "./parts";

const MICRO = 1_000_000;
const dollarTick = (value: number) => `$${compact(value)}`;
/** As tall as a chart with its table view, so an empty card sits level with a drawn one. */
const CHART_EMPTY = "min-h-[236px]";

/** Revenue: money in, what it costs to serve, and who uses the free credit sign-ups get. */
export function RevenueTab({ days, refresh, onAccount }: { days: OpsRange; refresh: number; onAccount: (tenant: string) => void }) {
  const revenue = useOps<AdminRevenue>(`/api/revenue?days=${days}`, refresh);
  const data = revenue.data;
  const tiles = data?.tiles;
  return (
    <>
      <div className="mb-10">
        <Ready state={revenue.state}>
          {tiles && (
            <Stats>
              <Stat label="Revenue" value={micros(tiles.revenue.current)} compare={tiles.revenue} compareLabel={`vs the ${days} days before`}
                detail={tiles.refunds.current ? `${micros(tiles.refunds.current)} refunded` : undefined}
                hint="Credit people bought in the range, by checkout or automatic top-up, at the full amount. The team's own purchases are left out." />
              <Stat label="Paying accounts" value={count(tiles.paying_accounts)} detail={`${plural(tiles.first_purchases.current, "first purchase")} in ${days} days`}
                hint="Accounts that have ever bought credit and not had it all refunded." />
              <Stat label="Credit held" value={micros(tiles.outstanding_purchased + tiles.outstanding_free)}
                detail={`${micros(tiles.outstanding_purchased)} bought · ${micros(tiles.outstanding_free)} free`}
                hint="What accounts hold now and have not spent. Free credit is spent first, so what is left of a paying account's balance is mostly what it bought." />
              <Stat label="Auto top-up on" value={count(tiles.auto_topup)} detail={`of ${plural(tiles.paying_accounts, "paying account")}`}
                hint="Accounts that buy more credit by themselves when they run low." />
            </Stats>
          )}
        </Ready>
      </div>

      <Section title="Purchases" description="Credit checkouts and automatic top-ups at their full amount. By UTC day and calendar month.">
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Purchases per day" description={data?.daily.some(row => row.amount) ? `${micros(data.daily.reduce((sum, row) => sum + row.amount, 0))} in the last ${days} days` : undefined} state={revenue.state}>{data && <DailyPurchases data={data} days={days} />}</Panel>
          <Panel title="Revenue by month" description="The last 12 months" state={revenue.state}>{data && <MonthlyRevenue data={data} />}</Panel>
        </div>
      </Section>

      <Section title="Charged vs what providers cost" description={`In the last ${days} days: what accounts were charged (model calls, agent hours, storage) against what model providers cost us for their calls on our keys.`}>
        <Panel title="Paying and free-credit accounts" flush state={revenue.state}>{data && <Margins data={data} />}</Panel>
      </Section>

      <Section title="Free credit" description="Who uses the $5 that new accounts get, and whether it leads to buying. All time, self-serve accounts.">
        <div className="mb-4">
          <Ready state={revenue.state}>
            {data && (() => {
              const free = data.free_credit;
              return (
                <Stats>
                  <Stat label="Given free credit" value={count(free.accounts)} detail={`${micros(free.given)} in all`} hint="Self-serve accounts given credit for free: the starting grant, a card check, or an operator." />
                  <Stat label="Used any" value={count(free.used_any)} detail={`${percent(free.used_any, free.accounts)} of them`} hint="Spent at least a cent of it." />
                  <Stat label="Used it all" value={count(free.buckets.used_up)} detail={`${percent(free.buckets.used_up, free.accounts)} of them`} hint="Less than a cent of it left." />
                  <Stat label="Bought credit" value={count(free.bought)} detail={`${percent(free.bought, free.accounts)} of them`} hint="Of the accounts given free credit, the ones that also bought some." />
                </Stats>
              );
            })()}
          </Ready>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="How much of it they used" state={revenue.state}>{data && <Buckets data={data} />}</Panel>
          <Panel title="Who got none, and what it costs" state={revenue.state}>{data && <Decisions data={data} />}</Panel>
        </div>
        <div className="mt-4">
          <Panel title="Accounts with free credit" flush state={revenue.state} hint="The 200 that used the most first. Open one to see its agents.">
            {data && <FreeCreditTable rows={data.free_credit.rows} onAccount={onAccount} />}
          </Panel>
        </div>
      </Section>
    </>
  );
}

function DailyPurchases({ data, days }: { data: AdminRevenue; days: number }) {
  if (!data.daily.some(row => row.amount || row.refunds)) {
    return <Empty icon={<ShoppingCart />} className={CHART_EMPTY}>No purchases in the last {days} days yet. Bars appear here with the first checkout.</Empty>;
  }
  return (
    <ColumnChart label="Purchases per day, in dollars" format={usd} axis={dollarTick}
      series={[{ key: "amount", label: "bought", color: FOCUS }]}
      data={data.daily.map(row => ({
        ...dayColumn(row.date, data.range.incomplete_date), values: [row.amount / MICRO],
        more: [{ value: count(row.purchases), label: row.purchases === 1 ? "purchase" : "purchases" }, ...(row.refunds ? [{ value: micros(row.refunds), label: "refunded" }] : [])],
      }))}
      table={{ columns: ["Day (UTC)", "Bought", "Purchases", "Refunded"], rows: [...data.daily].reverse().map(row => [dayColumn(row.date, data.range.incomplete_date).title, micros(row.amount), row.purchases, micros(row.refunds)]) }} />
  );
}

function MonthlyRevenue({ data }: { data: AdminRevenue }) {
  if (!data.monthly.some(row => row.amount || row.refunds)) {
    return <Empty icon={<ShoppingCart />} className={CHART_EMPTY}>No purchases in the last 12 months yet.</Empty>;
  }
  const current = data.range.end_date.slice(0, 7);
  return (
    <ColumnChart label="Revenue by month, in dollars" format={usd} axis={dollarTick}
      series={[{ key: "amount", label: "bought", color: FOCUS }]}
      data={data.monthly.map(row => ({
        key: row.month, title: row.month === current ? `${month(row.month, true)} · so far` : month(row.month, true), tick: month(row.month), partial: row.month === current,
        values: [row.amount / MICRO],
        more: [{ value: count(row.buyers), label: row.buyers === 1 ? "buyer" : "buyers" }, ...(row.refunds ? [{ value: micros(row.refunds), label: "refunded" }] : [])],
      }))}
      table={{ columns: ["Month", "Bought", "Buyers", "Refunded"], rows: [...data.monthly].reverse().map(row => [month(row.month, true), micros(row.amount), row.buyers, micros(row.refunds)]) }} />
  );
}

function Margins({ data }: { data: AdminRevenue }) {
  const { spend } = data;
  const rows = [
    { key: "paying", label: "Paying accounts", charged: spend.paying_charged / MICRO, cost: spend.paying_provider_cost, note: "Spending credit they paid for", what: "Charged" },
    { key: "free", label: "On free credit", charged: spend.free_charged / MICRO, cost: spend.free_provider_cost, note: "Spending free credit: no money came in", what: "Taken from free credit" },
  ];
  return (
    <div className="grid sm:grid-cols-2 sm:divide-x">
      {rows.map(row => {
        const margin = row.charged - row.cost;
        return (
          <div key={row.key} className="border-t px-4 py-3.5">
            <p className="text-sm font-medium">{row.label}</p>
            <p className="text-muted-foreground text-xs">{row.note}</p>
            <dl className="mt-3 grid grid-cols-3 gap-3 text-xs">
              <div><dt className="text-muted-foreground">{row.what}</dt><dd className="mt-0.5 text-base font-semibold">{usd(row.charged)}</dd></div>
              <div><dt className="text-muted-foreground">Providers cost us</dt><dd className="mt-0.5 text-base font-semibold">{usd(row.cost)}</dd></div>
              {row.key === "paying" ? (
                <div>
                  <dt className="text-muted-foreground">Margin</dt>
                  <dd className="mt-0.5 text-base font-semibold">{row.charged || row.cost ? `${margin < 0 ? "−" : ""}${usd(Math.abs(margin))}` : "—"}</dd>
                  {row.charged > 0 && <dd className="text-muted-foreground">{margin < 0 ? "−" : ""}{percent(Math.abs(margin), row.charged)} of what they were charged</dd>}
                </div>
              ) : null}
            </dl>
          </div>
        );
      })}
    </div>
  );
}

const BUCKETS: { key: AdminFreeCreditBucket; label: string; detail: string }[] = [
  { key: "untouched", label: "Untouched", detail: "" },
  { key: "tried", label: "Tried it", detail: "(under 25%)" },
  { key: "using", label: "Using it", detail: "(25 to 75%)" },
  { key: "nearly_out", label: "Nearly out", detail: "(over 75%)" },
  { key: "used_up", label: "Used it all", detail: "" },
];

function Buckets({ data }: { data: AdminRevenue }) {
  const free = data.free_credit;
  if (!free.accounts) return <Empty>No account has been given free credit yet.</Empty>;
  return (
    <>
      <p className="text-muted-foreground mb-3 text-xs">{plural(free.accounts, "account")} given free credit, by how much of it they spent. {micros(free.used)} of {micros(free.given)} used.</p>
      <SplitBar unit="accounts" label="Accounts by how much free credit they used"
        parts={BUCKETS.map((bucket, index) => ({ key: bucket.key, label: bucket.label, detail: bucket.detail, value: free.buckets[bucket.key], color: ORDINAL[index] }))} />
    </>
  );
}

function Decisions({ data }: { data: AdminRevenue }) {
  const free = data.free_credit, decisions = free.decisions;
  const rows: [string, string, string?][] = [
    ["Self-serve accounts without free credit", count(free.without)],
    ["GitHub sign-ups given the starting credit", count(decisions.eligible)],
    ["GitHub account too new to get it", count(decisions.ineligible), "They can still unlock it by checking a card."],
    ["Unlocked it with a card", count(decisions.card_unlocked)],
    ["Signed up while starting credit was off", count(decisions.disabled)],
    ["Decided before decisions were kept", count(decisions.legacy), "Signed up again with a GitHub account that had one already, or got credit before these were recorded."],
  ];
  return (
    <>
      <dl className="grid text-xs">
        {rows.map(([label, value, hint]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 border-b py-1.5 first:pt-0">
            <dt className={cn("flex items-center gap-1", label.startsWith("Self-serve") ? "font-medium" : "text-muted-foreground")}>{label}{hint && <Hint>{hint}</Hint>}</dt>
            <dd className="font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs"><span className="text-muted-foreground">What free credit has cost us in provider calls, all time:</span> <span className="font-mono">{usd(free.provider_cost)}</span></p>
    </>
  );
}

const VIA: Record<AdminFreeCreditAccount["via"], string> = { github: "GitHub sign-up", card: "Card check", operator: "Operator", other: "Other" };

function FreeCreditTable({ rows, onAccount }: { rows: AdminFreeCreditAccount[]; onAccount: (tenant: string) => void }) {
  const columns: Column<AdminFreeCreditAccount>[] = [
    { key: "name", label: "Account", cell: row => <span className="block max-w-56 truncate font-medium" title={row.name}>{row.name}</span>, sort: row => row.name.toLowerCase() },
    { key: "via", label: "How they got it", cell: row => VIA[row.via], sort: row => row.via },
    { key: "used", label: "Used", sort: row => row.given ? row.used / row.given : 0, cell: row => (
      <span className="flex items-center gap-2.5"><Meter value={row.used} max={row.given} label={`${row.name} used ${percent(row.used, row.given)} of its free credit`} />
        <span className="font-mono tabular-nums">{micros(row.used)} <span className="text-muted-foreground">of {micros(row.given)}</span></span></span>
    ) },
    { key: "left", label: "Left", align: "right", cell: row => micros(row.left), sort: row => row.left },
    { key: "last_active", label: "Last active", cell: row => ago(row.last_active), sort: row => row.last_active ?? "" },
    { key: "active_days", label: "Active days", align: "right", cell: row => count(row.active_days), sort: row => row.active_days },
    { key: "bought", label: "Bought", align: "right", cell: row => row.purchased > 0 ? micros(row.purchased) : <span className="text-muted-foreground">No</span>, sort: row => row.purchased },
  ];
  return <DataTable rows={rows} columns={columns} rowKey={row => row.tenant} search={row => `${row.name} ${row.tenant}`} searchLabel="Find an account" onOpen={row => onAccount(row.tenant)}
    empty={<Empty>No account has been given free credit yet.</Empty>} />;
}
