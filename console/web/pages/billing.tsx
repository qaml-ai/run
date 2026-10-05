import { useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { BillingAlertsSection } from "@/components/billing-alerts";
import { cardLabel, invoiceLink, type BillingState } from "@/components/billing-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorAlert } from "@/components/common";
import { needsStartingCredit, StartingCreditHelp } from "@/components/starting-credit";
import { api, formatMicros, formatNumber, type Billing, type BusyAgents, type LedgerEntry, type LedgerKind } from "@/lib/api";

const KIND_LABELS: Record<LedgerKind, string> = {
  grant: "Credit grant", purchase: "Purchase", usage: "Agent usage", storage: "Storage", adjustment: "Adjustment", refund: "Refund",
};

function activityDetail(entry: LedgerEntry) {
  const meta = entry.metadata;
  if (meta.card) return cardLabel(meta.card);
  if (entry.kind === "usage") {
    const parts = [];
    if (meta.hour) parts.push(Date.now() < entry.createdAt + 3_600_000 ? "This hour so far" : "Hour total");
    if (meta.tokens) parts.push(`${formatMicros(meta.tokens)} model tokens`);
    if (meta.funding) parts.push(`${formatMicros(meta.funding)} provider credit funding`);
    if (meta.activeMs) parts.push(`${formatNumber(Math.round(meta.activeMs / 1000))} s of agent time`);
    if (meta.searches) parts.push(`${formatNumber(meta.searches)} web search${meta.searches === 1 ? "" : "es"}`);
    if (meta.renders) parts.push(`${formatNumber(meta.renders)} page render${meta.renders === 1 ? "" : "s"}`);
    if (meta.toolSearches) parts.push(`${formatNumber(meta.toolSearches)} tool search${meta.toolSearches === 1 ? "" : "es"}`);
    return parts.join(" · ");
  }
  if (entry.kind === "storage") return `${formatNumber((meta.bytes ?? 0) / 1e9)} GB stored`;
  return meta.reason;
}

function Activity({ entries }: { entries: LedgerEntry[] }) {
  return <ul className="divide-y border-b">{entries.map(entry => {
    const meta = entry.metadata, url = invoiceLink(meta.invoiceUrl);
    const detail = activityDetail(entry);
    return <li key={entry.id} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 py-3 text-sm sm:grid-cols-[140px_minmax(0,1fr)_auto]">
      <time dateTime={new Date(entry.createdAt).toISOString()} className="text-muted-foreground col-span-2 text-xs tabular-nums sm:col-span-1">{new Date(entry.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1"><span>{meta.autoTopup ? "Auto top-up" : KIND_LABELS[entry.kind]}</span>{detail && <span className="text-muted-foreground break-words text-xs">{detail}</span>}{url && <a className="text-xs underline underline-offset-4" href={url} target="_blank" rel="noopener noreferrer">Invoice ↗</a>}</div>
      <span className={`text-right font-mono tabular-nums ${entry.amount > 0 ? "font-semibold" : "text-muted-foreground"}`}>{entry.amount > 0 ? "+" : ""}{formatMicros(entry.amount)}</span>
    </li>;
  })}</ul>;
}

function AutoSection({ state }: { state: BillingState }) {
  const a = state.auto.data, card = state.payment.data?.card;
  const label = !a ? "" : a.state === "cancelling" ? "Cancelling" : a.state === "processing" ? "Topping up" : a.state === "action_required" ? "Action needed" : a.state === "on" ? "On" : a.state === "off" ? "Off" : "Paused";
  const danger = a && ["action_required", "paused_declined", "paused_no_card", "paused_expired"].includes(a.state);
  return <section className="border-y py-5">
    <div className="flex items-center gap-3"><h2 className="text-sm font-semibold">Auto top-up</h2>{a && <Badge variant={danger ? "destructive" : a.state === "on" ? "info" : a.state === "processing" ? "live" : "secondary"}>{label}</Badge>}<Button variant="outline" size="sm" className="ml-auto" disabled={!a} onClick={() => state.setDialog("auto")}>{a?.enabled ? "Edit" : "Set up"}</Button></div>
    <ErrorAlert error={state.auto.error} />
    {!a ? <Skeleton className="mt-3 h-5 w-64" /> : <>
      <p className="mt-2 text-sm">{a.enabled ? <>Below {formatMicros(a.threshold)}, add {formatMicros(a.amount)}{card && <> · {cardLabel(card)}</>}</> : "Refill automatically when your balance runs low."}</p>
      {(a.enabled || a.held > 0 || a.usedThisPeriod > 0) && <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs"><div role="meter" aria-label="Monthly automatic top-up spending" aria-valuemin={0} aria-valuemax={a.monthlyLimit} aria-valuenow={Math.min(a.usedThisPeriod, a.monthlyLimit)} aria-valuetext={`${formatMicros(a.usedThisPeriod)} of ${formatMicros(a.monthlyLimit)}`} className="bg-muted h-1 w-32"><div className={`h-full ${a.state === "limit_reached" ? "bg-destructive" : "bg-foreground"}`} style={{ width: `${Math.min(100, a.usedThisPeriod / a.monthlyLimit * 100)}%` }} /></div><span>{formatMicros(a.usedThisPeriod)} of {formatMicros(a.monthlyLimit)} this month{a.held > 0 && <> · {formatMicros(a.held)} pending</>}</span></div>}
      {a.state === "limit_reached" && <p className="bg-muted mt-3 px-3 py-2 text-sm">This month's limit is reached. Auto top-up resumes {new Date(a.resetsAt).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })} (UTC). <button className="underline underline-offset-4" onClick={() => state.setDialog("auto")}>Raise limit</button></p>}
      {a.state === "paused_expired" && <p className="bg-muted mt-3 px-3 py-2 text-sm">Paused: bank confirmation expired. Retry to review and authorize a new top-up.</p>}
      {a.state === "reconcile" && <p className="bg-muted mt-3 px-3 py-2 text-sm">We're checking a recent top-up, so auto top-up is paused for now. Questions? <a className="underline" href="mailto:support@camelai.com">support@camelai.com</a>.</p>}
      {!a.enabled && a.attempt && <p className="text-muted-foreground mt-2 text-xs">New top-ups are off. The pending {formatMicros(a.attempt.total)} top-up may still finish.</p>}
    </>}
  </section>;
}

export function TierSection({ busy }: { busy: BusyAgents }) {
  const next = busy.next;
  return <section className="border-t py-5">
    <div className="flex items-center gap-3"><h2 className="text-sm font-semibold">Usage tier</h2>{busy.source === "tier" ? <Badge variant="secondary">{busy.tier}</Badge> : <Badge variant="secondary">Custom</Badge>}</div>
    <p className="mt-2 text-sm">Up to {formatNumber(busy.limit)} agents busy at once{busy.busy !== undefined && <span className="text-muted-foreground"> · {formatNumber(busy.busy)} busy now</span>}</p>
    {busy.source === "tier" && (next
      ? <p className="text-muted-foreground mt-2 text-xs">{next.tier} ({formatNumber(next.limit)} busy agents) once you've paid {formatMicros(next.paid)} in total for credit; {formatMicros(Math.max(0, next.paid - (busy.paid ?? 0)))} to go. It applies as soon as the payment lands.</p>
      : <p className="text-muted-foreground mt-2 text-xs">The highest tier. Need more? <a className="underline" href="mailto:support@camelai.com">support@camelai.com</a></p>)}
    {busy.source !== "tier" && <p className="text-muted-foreground mt-2 text-xs">Set for this account.</p>}
  </section>;
}

function RatesDialog({ data, close }: { data: Billing; close(): void }) {
  return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent><DialogHeader><DialogTitle>Rates</DialogTitle><DialogDescription>Prepaid credit covers your usage.</DialogDescription></DialogHeader>
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-3 text-sm"><dt>Agent time, per active hour</dt><dd className="font-mono">{formatMicros(data.rates.agentHour)}</dd><dt>Storage, per GB-month</dt><dd className="font-mono">{formatMicros(data.rates.storageGbMonth)}</dd>{Object.entries(data.rates.webSearch).map(([provider, price]) => <div key={provider} className="contents"><dt>Web search ({provider}), each</dt><dd className="font-mono">{formatMicros(price)}</dd></div>)}<dt>Rendered pages, each</dt><dd className="font-mono">{formatMicros(data.rates.webRender)}</dd><dt>Credit processing fee</dt><dd className="font-mono">{data.rates.purchaseFeeBps / 100}%</dd></dl>
    <p className="text-muted-foreground text-sm">Model usage is billed at provider-reported cost, estimated from list prices when unavailable. {data.rates.openrouterCreditMultiplier !== undefined && <>OpenRouter credits cost ${data.rates.openrouterCreditMultiplier} per $1 of provider credits, including funding costs. </>}Meaning-ranked tool search is billed at cost. Model and web tools using your own keys have no platform charge.</p>
    <p className="text-muted-foreground text-xs">Agent time is metered continuously; storage is charged daily.{data.freeCredit && " Accounts that haven't purchased credit have lower agent and hourly spend limits."}</p>
  </DialogContent></Dialog>;
}

/** `readOnly`: a console session signed in to with a token, which sees billing but cannot change it. */
export function BillingPage({ state, readOnly = false }: { state: BillingState; readOnly?: boolean }) {
  const { billing } = state, data = billing.data;
  const [rates, setRates] = useState(false);
  const [returned, setReturned] = useState(() => new URLSearchParams(location.search).get("checkout"));
  const [session] = useState(() => new URLSearchParams(location.search).get("session"));
  // Back from a card check: `card_check` is the Checkout session, settled here in case Stripe's webhook has not arrived.
  const [cardCheck, setCardCheck] = useState(() => new URLSearchParams(location.search).get("card_check"));
  const [cardOutcome, setCardOutcome] = useState<{ status: "granted" | "not_granted" | "pending"; amount: number }>();
  useEffect(() => {
    if (!cardCheck?.startsWith("cs_") || cardOutcome) return;
    api<{ status: "granted" | "not_granted" | "pending"; amount: number }>("/v1/billing/card-check/confirm", { body: { session: cardCheck } })
      .then(outcome => { setCardOutcome(outcome); void billing.reload(); }, () => setCardOutcome({ status: "pending", amount: 0 }));
  }, [cardCheck, cardOutcome, billing.reload]);
  const dismissCard = () => { const q = new URLSearchParams(location.search); q.delete("card_check"); history.replaceState(null, "", location.pathname + (q.size ? `?${q}` : "")); setCardCheck(null); };
  const [gaveUp, setGaveUp] = useState(false), [arrived, setArrived] = useState(false);
  const [older, setOlder] = useState<LedgerEntry[]>([]);
  const [next, setNext] = useState<number | null>();
  const [loading, setLoading] = useState(false), [error, setError] = useState<string>();
  const recentIds = new Set(data?.recent.map(e => e.id));
  const entries = [...(data?.recent ?? []), ...older.filter(e => !recentIds.has(e.id))];
  const cursor = next === undefined ? data?.recent.at(-1)?.id : next;
  const seen = returned === "success" && !!data?.recent.some(e => e.kind === "purchase" && (session ? e.metadata?.session === session : !e.metadata.autoTopup && Date.now() - e.createdAt < 15 * 60_000));
  useEffect(() => { if (seen) setArrived(true); }, [seen]);
  useEffect(() => {
    if (returned !== "success" || arrived || gaveUp || data?.billing === "none") return;
    const poll = setInterval(() => void billing.reload(), 3_000), stop = setTimeout(() => setGaveUp(true), 120_000);
    return () => { clearInterval(poll); clearTimeout(stop); };
  }, [returned, arrived, gaveUp, data?.billing, billing.reload]);
  const dismiss = () => { const q = new URLSearchParams(location.search); q.delete("checkout"); q.delete("session"); history.replaceState(null, "", location.pathname + (q.size ? `?${q}` : "")); setReturned(null); };
  async function loadMore() {
    if (cursor == null || loading) return;
    setLoading(true);
    try { const page = await api<{ entries: LedgerEntry[]; next?: number }>(`/v1/billing/ledger?before=${cursor}&limit=50`); setOlder(current => [...current, ...page.entries]); setNext(page.next ?? null); }
    catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }
  return <div className="mx-auto max-w-[760px]">
    <header className="mb-8"><div className="flex flex-wrap items-center justify-between gap-4"><h1 className="text-2xl font-semibold tracking-tight">Billing</h1>{data?.billing === "prepaid" && data.checkout && !readOnly && <div className="flex flex-wrap gap-2">{state.payment.data?.portal && state.payment.data.customer && <Button variant="outline" disabled={state.busy} onClick={() => void state.portal("manage")}>Manage billing ↗</Button>}<Button onClick={() => state.setDialog("add")}><Plus />Add credit</Button></div>}</div><p className="text-muted-foreground mt-2 text-sm">Prepaid credit for model usage, agent time and storage. {data && <button className="text-foreground underline underline-offset-4" onClick={() => setRates(true)}>Rates</button>}</p></header>
    <ErrorAlert error={billing.error ?? state.error ?? state.payment.error ?? error} />
    {readOnly && <p role="status" className="bg-muted mb-5 p-3 text-sm">You signed in with a token, so billing is read-only here. Sign in with GitHub or Google to add credit or change billing.</p>}
    {state.notice && <p role="status" className="bg-muted mb-5 p-3 text-sm">{state.notice} <button className="underline" onClick={() => state.setNotice(undefined)}>Dismiss</button></p>}
    {returned && <p role="status" className="bg-muted mb-5 p-3 text-sm">{returned === "cancelled" ? "Checkout cancelled. Nothing was charged." : arrived ? "Credit added. Your new balance is below." : gaveUp ? "Stripe hasn't confirmed the payment yet. Your credit will appear when it does." : "Confirming payment. Your credit appears as soon as Stripe confirms it."} <button className="underline" onClick={dismiss}>Dismiss</button></p>}
    {cardCheck && <p role="status" className="bg-muted mb-5 p-3 text-sm">{cardCheck === "cancelled" ? "Card check cancelled. Nothing was charged."
      : !cardOutcome ? "Checking your card…"
      : cardOutcome.status === "granted" ? `Card verified. ${formatMicros(cardOutcome.amount)} of starting credit added.`
      : cardOutcome.status === "pending" ? "Stripe is still checking your card. Starting credit appears here once it's verified."
      : "We couldn't add starting credit with this card. Add credit to start running agents."} <button className="underline" onClick={dismissCard}>Dismiss</button></p>}
    {rates && data && <RatesDialog data={data} close={() => setRates(false)} />}
    {!data ? <Skeleton className="h-64 w-full" /> : data.billing === "none" ? <p className="bg-muted p-4 text-sm">This account isn't billed by the runtime. It uses its own or admin-configured provider keys.</p> : <>
      <section className="pb-7"><h2 className="text-muted-foreground text-xs">Balance</h2><p className="mt-1 font-mono text-[44px] leading-tight font-medium tracking-tight">{formatMicros(data.balance)}</p><p className="text-muted-foreground mt-2 text-sm">{formatMicros(-data.month.usage - data.month.storage)} spent this month</p>{data.freeCredit && data.startingCredit.status === "granted" && <Badge variant="secondary" className="mt-3">Starting credit</Badge>}{needsStartingCredit(data) && <div role="status" className="bg-muted text-muted-foreground mt-4 max-w-xl p-3 text-sm"><StartingCreditHelp credit={data.startingCredit} action /></div>}</section>
      <TierSection busy={data.busyAgents} />
      {data.checkout && !readOnly && <AutoSection state={state} />}
      {!readOnly && <BillingAlertsSection alerts={state.alerts} />}
      <section className="mt-9"><div className="mb-2 flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-semibold">Activity</h2><p className="text-muted-foreground text-xs">This month: {formatMicros(data.month.purchase + data.month.grant + data.month.adjustment + data.month.refund)} added, {formatMicros(-data.month.usage - data.month.storage)} spent</p></div>{entries.length ? <Activity entries={entries} /> : <p className="text-muted-foreground border-b py-4 text-sm">No credit movements yet.</p>}{cursor != null && entries.length >= 10 && <Button className="mt-3" variant="outline" size="sm" disabled={loading} onClick={() => void loadMore()}>{loading && <Loader2 className="animate-spin" />}Show older</Button>}</section>
    </>}
  </div>;
}
