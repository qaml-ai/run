import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, Loader2, Plus, Receipt } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
    // Usage accrues into one entry per UTC hour (older entries are one per flush).
    if (meta.hour) parts.push(Date.now() < entry.createdAt + 3_600_000 ? "This hour so far" : "Hour total");
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

const AMOUNTS = [5, 10, 25, 50, 100];

/** Choose an amount, then pay for it on Stripe's checkout page, which returns here. */
function AddCreditDialog({ rates, onClose }: { rates: Billing["rates"]; onClose: () => void }) {
  const [choice, setChoice] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const amount = Math.round(Number(choice) * 100) * 10_000;
  const valid = Number.isFinite(Number(choice)) && amount >= rates.minPurchase && amount <= rates.maxPurchase;
  // Whole cents, as the server and Stripe round it.
  const fee = Math.round(amount * rates.purchaseFeeBps / 10_000 / 10_000) * 10_000;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try { location.assign((await api<{ url: string }>("/v1/billing/checkout", { body: { amountUsd: Number(choice) } })).url); }
    catch (caught) { setError((caught as Error).message); setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add credit</DialogTitle>
            <DialogDescription>You pay on Stripe's checkout page; the credit appears here as soon as the payment goes through.</DialogDescription>
          </DialogHeader>
          <ErrorAlert error={error} />
          <div className="flex flex-wrap gap-2">
            {AMOUNTS.map(value => (
              <Button key={value} type="button" size="sm" variant={choice === String(value) ? "default" : "outline"} onClick={() => setChoice(String(value))}>${value}</Button>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="credit-amount">Amount (USD)</Label>
            <Input id="credit-amount" inputMode="decimal" value={choice} onChange={event => setChoice(event.target.value.replace(/[^0-9.]/g, ""))} />
            <p className="text-muted-foreground text-xs">Between {formatMicros(rates.minPurchase)} and {formatMicros(rates.maxPurchase)}.</p>
          </div>
          {valid && (
            <div className="bg-muted/40 grid grid-cols-[1fr_auto] gap-1 rounded-md border p-3 text-sm tabular-nums">
              <span>Credit</span><span className="text-right">{formatMicros(amount)}</span>
              <span className="text-muted-foreground">Processing fee ({rates.purchaseFeeBps / 100}%)</span><span className="text-muted-foreground text-right">{formatMicros(fee)}</span>
              <span className="font-medium">Total</span><span className="text-right font-medium">{formatMicros(amount + fee)}</span>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!valid || busy}>{busy && <Loader2 className="animate-spin" />}Continue to payment</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Stripe sends the buyer back with ?checkout=success or ?checkout=cancelled. */
function useCheckoutReturn() {
  const [returned, setReturned] = useState(() => new URLSearchParams(location.search).get("checkout"));
  const [session] = useState(() => new URLSearchParams(location.search).get("session"));
  const dismiss = () => { history.replaceState(null, "", location.pathname); setReturned(null); };
  return { returned, session, dismiss };
}

/** Stop waiting for the webhook's credit after this long, and say it may still come. */
const CHECKOUT_WAIT_MS = 2 * 60_000;

export function BillingPage() {
  const { returned, session, dismiss } = useCheckoutReturn();
  // After a payment, poll until the webhook's credit shows up, for a while.
  const [polling, setPolling] = useState(returned === "success");
  const [gaveUp, setGaveUp] = useState(false);
  const [arrived, setArrived] = useState(false);
  const billing = useApi<Billing>("/v1/billing", polling ? 3_000 : 30_000);
  const [adding, setAdding] = useState(false);
  const [older, setOlder] = useState<LedgerEntry[]>([]);
  const [next, setNext] = useState<number | null>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const data = billing.data;
  const entries = [...(data?.recent ?? []), ...older];
  const cursor = next === undefined ? data?.recent.at(-1)?.id : next;
  // The purchase has arrived once its entry (by checkout session; else any purchase in the last 15 minutes)
  // is among the recent ones. Latched, since a busy tenant's usage entries soon push it out of `recent`.
  const seen = returned === "success" && !!data?.recent.some(entry => entry.kind === "purchase" &&
    (session ? entry.metadata?.session === session : Date.now() - entry.createdAt < 15 * 60_000));
  useEffect(() => { if (seen) { setArrived(true); setPolling(false); } }, [seen]);
  // A tenant that isn't billed here never gets the credit (the purchase was another tenant's).
  useEffect(() => { if (data?.billing === "none") setPolling(false); }, [data?.billing]);
  useEffect(() => {
    if (!polling) return;
    const timer = setTimeout(() => { setGaveUp(true); setPolling(false); }, CHECKOUT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [polling]);

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
      <PageHeader title="Billing" description="Prepaid credit pays for model tokens on the platform's keys (at the provider's list price), time your agents spend in turns, and storage."
        actions={data?.billing === "prepaid" && data.checkout && <Button onClick={() => setAdding(true)}><Plus />Add credit</Button>} />
      <ErrorAlert error={billing.error ?? error} />
      {returned === "success" && data?.billing !== "none" && (
        <Alert className="mb-4">
          {arrived ? <CheckCircle2 /> : gaveUp ? <Receipt /> : <Loader2 className="animate-spin" />}
          <AlertTitle>{arrived ? "Credit added" : "Payment received"}</AlertTitle>
          <AlertDescription>
            {arrived ? "Thank you. Your new balance is below."
              : gaveUp ? "Stripe hasn't confirmed the payment yet. The credit is added when it does; refresh this page later."
              : "Your credit appears here as soon as Stripe confirms the payment, usually within seconds."}
            <Button variant="link" size="sm" className="h-auto p-0" onClick={dismiss}>Dismiss</Button>
          </AlertDescription>
        </Alert>
      )}
      {returned === "cancelled" && (
        <Alert className="mb-4">
          <Receipt /><AlertTitle>Checkout cancelled</AlertTitle>
          <AlertDescription>Nothing was charged. <Button variant="link" size="sm" className="h-auto p-0" onClick={dismiss}>Dismiss</Button></AlertDescription>
        </Alert>
      )}
      {adding && data && <AddCreditDialog rates={data.rates} onClose={() => setAdding(false)} />}
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
