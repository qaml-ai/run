import { Banner } from "@/components/banner";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { formatMicros } from "@/lib/api";
import { needsStartingCredit } from "@/components/starting-credit";
import { invoiceLink, type BillingState } from "@/components/billing-state";

export function BillingBanner({ state, hideStarting }: { state: BillingState; hideStarting: boolean }) {
  const b = state.billing.data, a = state.auto.data;
  if (!b || b.billing !== "prepaid") return null;
  const add = <Button size="sm" disabled={!b.checkout} onClick={() => state.setDialog("add")}>Add credit</Button>;
  const card = <Button size="sm" disabled={state.busy || !state.payment.data?.portal} onClick={() => void state.portal("payment_method")}>{a?.state === "paused_no_card" ? "Add card" : "Update card"} ↗</Button>;
  if (a?.state === "action_required") return <Banner danger><span>Your bank needs you to confirm a {formatMicros(a.attempt!.total)} top-up.</span>{invoiceLink(a.attempt?.invoiceUrl) ? <Button size="sm" asChild><a href={a.attempt!.invoiceUrl!} target="_blank" rel="noopener noreferrer">Confirm payment ↗</a></Button> : <Link to="billing">View billing</Link>}</Banner>;
  if (a?.state === "paused_declined") return <Banner danger><span>Auto top-up is paused: your card was declined.</span><div className="flex flex-wrap items-center gap-3">{card}<Button size="sm" disabled={state.busy || !a.attempt?.canRetry} onClick={() => void state.retry()}>Retry {formatMicros(a.attempt?.total ?? a.total)}</Button></div></Banner>;
  if (a?.state === "paused_no_card") return <Banner danger><span>Auto top-up is paused: there's no card on file.</span>{card}</Banner>;
  if (b.balance <= 0 && !needsStartingCredit(b)) return <Banner danger><span>You're out of credit. New runs are paused.</span>{add}</Banner>;
  if (a?.state === "reconcile") return <Banner><span>We're checking a recent top-up. Add credit manually to keep agents running.</span>{add}</Banner>;
  if (needsStartingCredit(b)) return hideStarting ? null : <Banner><span>Add credit to start running agents.</span>{add}</Banner>;
  if (state.alerts.data && b.balance < state.alerts.data.threshold && !a?.enabled && !a?.attempt) return <Banner><span>Your balance is low: {formatMicros(b.balance)}.</span><div className="flex flex-wrap items-center gap-3">{a && <button className="underline underline-offset-4" onClick={() => state.setDialog("auto")}>Turn on auto top-up</button>}{add}</div></Banner>;
  return null;
}

export function BillingBalance({ state, mobile = false }: { state: BillingState; mobile?: boolean }) {
  const b = state.billing.data, a = state.auto.data;
  if (!b || b.billing !== "prepaid") return null;
  const danger = (b.balance <= 0 && !needsStartingCredit(b)) || ["action_required", "paused_declined", "paused_no_card"].includes(a?.state ?? "");
  const low = b.balance < (state.alerts.data?.threshold ?? 2e6);
  return <Link to="billing" className={mobile ? "block text-right" : "hover:bg-sidebar-accent block border-b px-5 py-3"}>
    <span className="text-muted-foreground text-xs">Balance</span><span className={`flex items-center gap-2 font-mono ${mobile ? "justify-end text-sm" : "text-lg"}`}><span aria-hidden="true" className={`size-2 shrink-0 ${danger ? "bg-destructive" : a?.enabled ? "bg-[var(--chart-1)]" : low ? "border border-foreground" : "bg-muted-foreground"}`} />{formatMicros(b.balance)}</span>
  </Link>;
}
