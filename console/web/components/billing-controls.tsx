import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, formatMicros, type AutoTopupQuote, type Billing } from "@/lib/api";
import { AUTO_PATH, cardLabel, moneyInput, type BillingState } from "@/components/billing-state";
import { ErrorAlert } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PixelButton } from "@/components/ui/pixel-button";

export function BillingDialogs({ state }: { state: BillingState }) {
  const returned = useRef(false);
  const [restored, setRestored] = useState<AutoTopupQuote>();
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (returned.current || !state.auto.data || query.get("payment_method") !== "updated") return;
    returned.current = true;
    const resume = query.get("resume") === "auto-topup";
    query.delete("payment_method"); query.delete("resume");
    history.replaceState(null, "", location.pathname + (query.size ? `?${query}` : "") + location.hash);
    void (async () => {
      try {
        await api(`${AUTO_PATH}/refresh`, { body: {} });
        if (resume) {
          const quote = await api<AutoTopupQuote>(`${AUTO_PATH}/quote`);
          if (quote.card) { setRestored(quote); state.setDialog("auto"); }
          else state.setNotice("Card setup cancelled. Nothing was charged.");
        }
        await state.refresh();
      } catch (e) { state.setError((e as Error).message); }
    })();
  }, [state.auto.data]);
  const close = () => { state.setDialog(null); setRestored(undefined); };
  return <>
    {state.dialog === "add" && state.billing.data && <AddCreditDialog rates={state.billing.data.rates} onClose={close} />}
    {state.dialog === "auto" && state.auto.data && state.billing.data && <AutoDialog state={state} restored={restored} close={close} />}
  </>;
}

function AutoDialog({ state, restored, close }: { state: BillingState; restored?: AutoTopupQuote; close(): void }) {
  const current = state.auto.data!, rates = state.billing.data!.rates;
  const [threshold, setThreshold] = useState(String((restored?.threshold ?? current.threshold) / 1e6));
  const [amount, setAmount] = useState(String((restored?.amount ?? current.amount) / 1e6));
  const [limit, setLimit] = useState(String((restored?.monthlyLimit ?? current.monthlyLimit) / 1e6));
  const [quote, setQuote] = useState(restored);
  const [step, setStep] = useState<"edit" | "confirm" | "off">(restored ? "confirm" : "edit");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState<string>();
  const credit = Math.round(Number(amount) * 100) * 10_000;
  const fee = Math.round(credit * rates.purchaseFeeBps / 1e8) * 10_000;
  const total = credit + fee, cap = Number(limit) * 1e6;
  const valid = [threshold, amount, limit].every(moneyInput) && Number(threshold) >= 1 && Number(threshold) <= 500
    && credit >= rates.minPurchase && credit <= rates.maxPurchase && cap >= total && cap <= 100_000e6;
  const noEmail = !state.alerts.data?.recipients.some(r => r.status === "verified" && r.events.problems);
  const unpaid = current.attempt && current.attempt.state !== "processing";
  async function run(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(undefined); state.setError(undefined);
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { working.current = false; setBusy(false); }
  }
  async function review(e: FormEvent) {
    e.preventDefault(); if (!valid) return;
    await run(async () => {
      const next = await api<AutoTopupQuote>(`${AUTO_PATH}/quote`, { body: { thresholdUsd: Number(threshold), amountUsd: Number(amount), monthlyLimitUsd: Number(limit) } });
      setQuote(next); setConsent(false);
      if (!next.card) await state.portal("payment_method", true);
      else setStep("confirm");
    });
  }
  async function enable() {
    if (!quote || !consent) return;
    await run(async () => {
      try { await api(`${AUTO_PATH}/enable`, { body: { quoteId: quote.id, version: quote.version, consent: true } }); }
      catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setConsent(false);
          try { setQuote(await api<AutoTopupQuote>(`${AUTO_PATH}/quote?id=${quote.id}`)); }
          catch { setStep("edit"); }
          throw new Error("The details changed. Review them and confirm again.");
        }
        throw e;
      }
      await state.refresh(); close();
    });
  }
  const note = "bg-muted px-3 py-2 text-sm text-muted-foreground";
  return <Dialog open onOpenChange={open => { if (!open && !busy && !state.busy) close(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto">
    <DialogHeader><DialogTitle>{step === "off" ? "Turn off auto top-up?" : step === "confirm" ? "Confirm auto top-up" : current.enabled ? "Edit auto top-up" : "Set up auto top-up"}</DialogTitle>
      <DialogDescription>{step === "off" ? "Your card stays saved in Stripe." : step === "confirm" ? "Review the charge and authorize automatic payments." : "Refill your balance automatically, within a monthly limit."}</DialogDescription></DialogHeader>
    <ErrorAlert error={error ?? state.error} />
    {step === "off" ? <>
      {current.attempt && <p className={note}>{current.attempt.state === "processing" || current.attempt.state === "action_required" ? "The top-up in progress may still finish." : "The unpaid top-up will be cancelled once Stripe confirms it is not being paid."}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setStep("edit")}>Keep it on</Button><Button disabled={busy} onClick={() => void run(async () => { await api(`${AUTO_PATH}/disable`, { body: {} }); await state.refresh(); close(); })}>Turn off</Button></DialogFooter>
    </> : step === "confirm" && quote ? <>
      <div className="flex items-center justify-between border-y py-3 text-sm"><span>{cardLabel(quote.card)}</span><Button variant="link" size="sm" disabled={busy || state.busy} onClick={() => void state.portal("payment_method", true)}>Change ↗</Button></div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm"><dt>Below</dt><dd className="font-mono">{formatMicros(quote.threshold)}</dd><dt>Add credit</dt><dd className="font-mono">{formatMicros(quote.amount)}</dd><dt>Each charge</dt><dd className="font-mono">{formatMicros(quote.total)}</dd><dt>Monthly limit, including fees</dt><dd className="font-mono">{formatMicros(quote.monthlyLimit)}</dd></dl>
      <p className="text-muted-foreground text-xs">Each charge includes a {formatMicros(quote.fee)} processing fee. Monthly limits reset on the first day of the month, UTC.</p>
      {quote.immediate && <p className="bg-[var(--tint-info)] px-3 py-2 text-sm">The first {formatMicros(quote.total)} top-up is charged now.</p>}
      {unpaid && <p className={note}>The unpaid {formatMicros(current.attempt!.total)} top-up keeps its amount. Retry it or turn off auto top-up.</p>}
      <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1!" checked={consent} disabled={busy || !quote.card} onChange={e => setConsent(e.target.checked)} /><span>I authorize camelAI to charge my default card in Stripe, currently {cardLabel(quote.card)}, {formatMicros(quote.total)} each time my balance drops below {formatMicros(quote.threshold)}, up to {formatMicros(quote.monthlyLimit)} a month, until I turn off auto top-up.</span></label>
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => { setStep("edit"); setConsent(false); }}>Back</Button><Button disabled={busy || !consent || !quote.card} onClick={() => void enable()}>{busy ? "Saving…" : quote.immediate ? `${current.enabled ? "Save" : "Turn on"} and charge ${formatMicros(quote.total)}` : current.enabled ? "Save" : "Turn on"}</Button></DialogFooter>
    </> : <form className="grid gap-4" onSubmit={review}>
      <div className="grid gap-2"><Label htmlFor="topup-threshold">When balance drops below (USD)</Label><Input id="topup-threshold" inputMode="decimal" value={threshold} disabled={busy} onChange={e => setThreshold(e.target.value)} /><p className="text-muted-foreground text-xs">$1–$500</p></div>
      <div className="grid gap-2"><Label htmlFor="topup-amount">Add (USD)</Label><Input id="topup-amount" inputMode="decimal" value={amount} disabled={busy} onChange={e => setAmount(e.target.value)} /><div className="flex gap-2">{[10,20,50,100].map(n => <Button key={n} type="button" size="sm" variant={Number(amount) === n ? "default" : "outline"} disabled={busy} onClick={() => setAmount(String(n))}>${n}</Button>)}</div><p className="text-muted-foreground text-xs">{formatMicros(rates.minPurchase)}–{formatMicros(rates.maxPurchase)}</p></div>
      <div className="grid gap-2"><Label htmlFor="topup-limit">Monthly limit, including fees (USD)</Label><Input id="topup-limit" inputMode="decimal" value={limit} disabled={busy} onChange={e => setLimit(e.target.value)} />{valid && <p className="text-muted-foreground text-xs">Up to {Math.floor(cap / total)} top-ups a month, fees included.</p>}</div>
      {valid && <p className="border-y py-3 text-sm">Each top-up <strong className="font-mono">{formatMicros(total)}</strong> <span className="text-muted-foreground">({formatMicros(credit)} + {formatMicros(fee)} fee)</span></p>}
      {valid && !current.attempt && state.billing.data!.balance < Number(threshold) * 1e6 && <p className="bg-[var(--tint-info)] px-3 py-2 text-sm">Your balance is already below {formatMicros(Number(threshold) * 1e6)}, so the first top-up happens right away if the monthly limit allows it.</p>}
      {unpaid && <p className={note}>The unpaid {formatMicros(current.attempt!.total)} top-up keeps its amount. Retry it or turn off auto top-up.</p>}
      {noEmail && <p className={note}>No alert email yet. If a top-up fails, you'll only see it here.</p>}
      <DialogFooter className="sm:items-center">{current.enabled && <Button type="button" variant="link" className="sm:mr-auto" disabled={busy} onClick={() => setStep("off")}>Turn off auto top-up</Button>}<Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" disabled={!valid || busy || state.busy || (!state.payment.data?.card && !state.payment.data?.portal)}>{busy ? "Loading…" : state.payment.data?.card ? "Continue" : "Continue to Stripe ↗"}</Button></DialogFooter>
      {!state.payment.data?.card && state.payment.data && !state.payment.data.portal && <p className={note}>Card setup is unavailable. Contact support@camelai.com.</p>}
    </form>}
  </DialogContent></Dialog>;
}

const AMOUNTS = [10, 25, 50, 100];

/** Choose an amount, then pay for it on Stripe's checkout page, which returns here. */
function AddCreditDialog({ rates, onClose }: { rates: Billing["rates"]; onClose: () => void }) {
  const [choice, setChoice] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const attempt = useRef<{ amount: number; requestId: string } | null>(null);
  const amount = Math.round(Number(choice) * 100) * 10_000;
  const valid = Number.isFinite(Number(choice)) && Math.abs(Number(choice) * 100 - Math.round(Number(choice) * 100)) < 1e-6 && amount >= rates.minPurchase && amount <= rates.maxPurchase;
  // Whole cents, as the server and Stripe round it.
  const fee = Math.round(amount * rates.purchaseFeeBps / 10_000 / 10_000) * 10_000;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !valid) return;
    setBusy(true); setError(undefined);
    if (attempt.current?.amount !== amount) attempt.current = { amount, requestId: crypto.randomUUID() };
    try { location.assign((await api<{ url: string }>("/v1/billing/checkout", { body: { amountUsd: Number(choice), requestId: attempt.current.requestId } })).url); }
    catch (caught) { setError((caught as Error).message); setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add credit</DialogTitle>
            <DialogDescription>You pay on Stripe's checkout page; the credit appears here as soon as the payment goes through.</DialogDescription>
          </DialogHeader>
          <ErrorAlert error={error} />
          <div className="flex flex-wrap gap-2">
            {AMOUNTS.map(value => (
              <Button key={value} type="button" size="sm" variant={choice === String(value) ? "default" : "outline"} disabled={busy} onClick={() => setChoice(String(value))}>${value}</Button>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="credit-amount">Amount (USD)</Label>
            <Input id="credit-amount" disabled={busy} inputMode="decimal" value={choice} onChange={event => setChoice(event.target.value.replace(/[^0-9.]/g, ""))} />
            <p className="text-muted-foreground text-xs">Between {formatMicros(rates.minPurchase)} and {formatMicros(rates.maxPurchase)}.</p>
          </div>
          {valid && (
            <div className="bg-muted grid grid-cols-[1fr_auto] gap-1 border p-3 text-sm tabular-nums">
              <span>Credit</span><span className="text-right font-mono">{formatMicros(amount)}</span>
              <span className="text-muted-foreground">Processing fee ({rates.purchaseFeeBps / 100}%)</span><span className="text-muted-foreground text-right font-mono">{formatMicros(fee)}</span>
              <span className="font-medium">Total</span><span className="text-right font-mono font-medium">{formatMicros(amount + fee)}</span>
            </div>
          )}
          <DialogFooter className="sm:items-center">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
            <PixelButton type="submit" loading={busy} disabled={!valid || busy}>Continue to payment</PixelButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
