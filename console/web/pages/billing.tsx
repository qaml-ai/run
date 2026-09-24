import { useState } from "react";
import { Loader2, Receipt } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatMicros, formatNumber, formatTime, useApi, type Billing, type LedgerEntry, type LedgerKind } from "@/lib/api";

const KIND_LABELS: Record<LedgerKind, string> = {
  grant: "Free credit", purchase: "Purchase", usage: "Agent usage", storage: "Storage", adjustment: "Adjustment", refund: "Refund",
};

/** What an entry was for, from its metadata. */
function detail(entry: LedgerEntry) {
  const meta = entry.metadata;
  if (entry.kind === "usage") {
    const parts = [];
    if (meta.tokens) parts.push(`${formatMicros(meta.tokens)} model tokens`);
    if (meta.activeMs) parts.push(`${formatNumber(Math.round(meta.activeMs / 1000))} s of agent time`);
    return parts.join(" · ");
  }
  if (entry.kind === "storage") return `${meta.day}: ${formatNumber(meta.bytes / 1e9)} GB stored`;
  return meta.reason ?? "";
}

function LedgerTable({ entries }: { entries: LedgerEntry[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow><TableHead>When</TableHead><TableHead>Kind</TableHead><TableHead>Detail</TableHead><TableHead className="text-right">Amount</TableHead></TableRow>
      </TableHeader>
      <TableBody>
        {entries.map(entry => (
          <TableRow key={entry.id}>
            <TableCell className="whitespace-nowrap tabular-nums">{formatTime(entry.createdAt)}</TableCell>
            <TableCell><Badge variant={entry.amount > 0 ? "default" : "secondary"}>{KIND_LABELS[entry.kind]}</Badge></TableCell>
            <TableCell className="text-muted-foreground text-xs">{detail(entry)}</TableCell>
            <TableCell className={`text-right tabular-nums ${entry.amount > 0 ? "text-emerald-600 dark:text-emerald-400" : ""}`}>{entry.amount > 0 ? "+" : ""}{formatMicros(entry.amount)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function BillingPage() {
  const billing = useApi<Billing>("/v1/billing", 30_000);
  const [older, setOlder] = useState<LedgerEntry[]>([]);
  const [next, setNext] = useState<number | null>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const data = billing.data;
  const entries = [...(data?.recent ?? []), ...older];
  const cursor = next === undefined ? data?.recent.at(-1)?.id : next;

  async function loadMore() {
    if (cursor == null) return;
    setLoading(true);
    try {
      const page = await api<{ entries: LedgerEntry[]; next?: number }>(`/v1/billing/ledger?before=${cursor}&limit=50`);
      setOlder(current => [...current, ...page.entries]);
      setNext(page.next ?? null);
    } catch (caught) { setError((caught as Error).message); }
    finally { setLoading(false); }
  }

  return (
    <>
      <PageHeader title="Billing" description="Prepaid credit pays for model tokens on the platform's keys (at the provider's list price), time your agents spend in turns, and storage." />
      <ErrorAlert error={billing.error ?? error} />
      {!data ? <Skeleton className="h-64 w-full" /> : data.billing === "none" ? (
        <Alert><Receipt /><AlertTitle>Not billed here</AlertTitle><AlertDescription>This tenant is not billed by the runtime: it uses its own or admin-configured provider keys.</AlertDescription></Alert>
      ) : (
        <>
          {data.balance <= 0 && (
            <Alert variant="destructive" className="mb-4">
              <Receipt /><AlertTitle>Your credit is used up</AlertTitle>
              <AlertDescription>New turns are refused until you add credit.</AlertDescription>
            </Alert>
          )}
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card size="sm">
              <CardHeader>
                <CardDescription>Balance</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{formatMicros(data.balance)}</CardTitle>
                {data.freeCredit && <Badge variant="outline" className="mt-1 w-fit">Free credit</Badge>}
              </CardHeader>
            </Card>
            {([
              ["Agent usage this month", -data.month.usage],
              ["Storage this month", -data.month.storage],
              ["Added this month", data.month.purchase + data.month.grant + data.month.adjustment + data.month.refund],
            ] as const).map(([label, value]) => (
              <Card key={label} size="sm">
                <CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-2xl tabular-nums">{formatMicros(value)}</CardTitle></CardHeader>
              </Card>
            ))}
          </div>
          <Card className="mb-6" size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Rates</CardTitle>
              <CardDescription>
                Agent time {formatMicros(data.rates.agentHour)} per active hour, metered continuously ·
                storage {formatMicros(data.rates.storageGbMonth)} per GB-month, charged daily ·
                model tokens at list price on the platform's keys; free with your own keys.
                {data.freeCredit && " Tenants on free credit have lower agent and hourly spend limits until their first purchase."}
              </CardDescription>
            </CardHeader>
          </Card>
          <h2 className="mb-3 text-sm font-medium">Ledger</h2>
          {entries.length === 0 ? <EmptyState icon={<Receipt />} title="No credit movements yet" /> : (
            <Card>
              <CardContent className="p-0"><LedgerTable entries={entries} /></CardContent>
            </Card>
          )}
          {cursor != null && entries.length >= 10 && (
            <div className="mt-3 flex justify-center">
              <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadMore()}>{loading && <Loader2 className="animate-spin" />}Show older</Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
