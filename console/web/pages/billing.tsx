import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorAlert, LearnMore } from "@/components/common";
import { formatCost, formatNumber, formatUsd, type Billing, type LedgerEntry, type Me, type useApi } from "@/lib/api";

const KIND_LABELS: Record<string, string> = {
  grant: "Credit grant",
  topup: "Credit top-up",
  purchase: "Purchase",
  usage: "Agent usage",
  adjustment: "Adjustment",
  refund: "Refund",
};

function Activity({ entries }: { entries: LedgerEntry[] }) {
  return (
    <ul className="divide-y border-b">
      {entries.map(entry => (
        <li
          key={entry.id}
          className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 py-3 text-sm sm:grid-cols-[140px_minmax(0,1fr)_auto]"
        >
          <time
            dateTime={new Date(entry.createdAt).toISOString()}
            className="text-muted-foreground col-span-2 text-xs tabular-nums sm:col-span-1"
          >
            {new Date(entry.createdAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span>{KIND_LABELS[entry.kind] ?? entry.kind}</span>
            {entry.note && <span className="text-muted-foreground break-words text-xs">{entry.note}</span>}
          </div>
          <span className={`text-right font-mono tabular-nums ${entry.amountUsd > 0 ? "font-semibold" : "text-muted-foreground"}`}>
            {entry.amountUsd > 0 ? "+" : ""}{formatUsd(entry.amountUsd)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function BillingPage({ billing, me }: { billing: ReturnType<typeof useApi<Billing>>; me: Me }) {
  const data = billing.data;
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const monthSpend = (data?.usage ?? [])
    .filter(u => u.day.startsWith(monthPrefix))
    .reduce((sum, u) => sum + u.costUsd, 0);
  const entries = data?.recent ?? [];
  const tier = data?.tier ?? me.tier;

  return (
    <div className="mx-auto max-w-[760px]">
      <header className="mb-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        </div>
        <p className="text-muted-foreground mt-2 text-sm">
          Prepaid credit for model usage and Firecracker VM time. <LearnMore page="pricing" />
        </p>
      </header>
      <ErrorAlert error={billing.error} />
      {!data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <section className="pb-7">
            <h2 className="text-muted-foreground text-xs">Balance</h2>
            <p className="mt-1 font-mono text-[44px] leading-tight font-medium tracking-tight">
              {formatUsd(data.balanceUsd)}
            </p>
            <p className="text-muted-foreground mt-2 text-sm">
              {formatCost(monthSpend)} spent this month · monthly cap {formatUsd(data.monthlyCapUsd)}
            </p>
          </section>

          <section className="border-t py-5">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold">Usage tier</h2>
              <Badge variant="secondary">{tier}</Badge>
            </div>
            <p className="mt-2 text-sm">
              {data.busyAgents.limit === null
                ? "No limit on agents busy at once"
                : <>Up to {formatNumber(data.busyAgents.limit)} agents busy at once</>}
              <span className="text-muted-foreground"> · {formatNumber(data.busyAgents.busy)} busy now</span>
            </p>
            {data.rateLimitRpm !== undefined && (
              <p className="text-muted-foreground mt-2 text-xs">
                Up to {formatNumber(data.rateLimitRpm)} requests per minute. Need higher limits or credits? Contact{" "}
                <a className="underline" href="mailto:support@camelai.com">support@camelai.com</a>.
              </p>
            )}
          </section>

          <section className="mt-7 border-t pt-6">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">Activity</h2>
              <p className="text-muted-foreground text-xs">Recent credit ledger entries</p>
            </div>
            {entries.length > 0 ? (
              <Activity entries={entries} />
            ) : (
              <p className="text-muted-foreground border-b py-4 text-sm">No credit movements recorded yet.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
