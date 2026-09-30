import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api, formatMicros, type Billing } from "@/lib/api";
import { Link } from "@/lib/router";
import { Banner } from "@/components/banner";
import { Button } from "@/components/ui/button";

export function needsStartingCredit(data: Billing | undefined) {
  return !!data && data.billing === "prepaid" && data.balance <= 0 && data.freeCredit &&
    (data.startingCredit?.status === "not_eligible" || data.startingCredit?.status === "not_granted");
}

/** Verifying a card in Stripe Checkout (setup mode, no charge) unlocks starting credit; Stripe returns to the billing page. */
export function VerifyCardButton() {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  return <span className="mt-3 flex flex-wrap items-center gap-3">
    <Button size="sm" disabled={busy} onClick={async () => {
      setBusy(true); setError(undefined);
      try { location.assign((await api<{ url: string }>("/v1/billing/card-check", { body: {} })).url); }
      catch (caught) { setError((caught as Error).message); setBusy(false); }
    }}>{busy && <Loader2 className="animate-spin" />}Verify a card</Button>
    {error && <span role="alert" className="text-destructive text-xs">{error}</span>}
  </span>;
}

/** `action`: offer the card check's button here (the billing page); elsewhere the page links to billing. */
export function StartingCreditHelp({ credit, action = false }: { credit: Billing["startingCredit"]; action?: boolean }) {
  if (credit.cardCheck) return <>
    Verify a card to get {formatMicros(credit.cardCheck.amount)} of starting credit. You won't be charged.
    {action && <VerifyCardButton />}
  </>;
  return <>
    {credit.status === "not_eligible" ? "This account doesn't qualify for starting credit." : "This account has no starting credit."}
    {" "}Add credit to start running agents.
    <span className="mt-1 block">If you think this is a mistake, email{" "}
      <a href="mailto:support@camelai.com" className="text-foreground underline underline-offset-4">support@camelai.com</a>.
    </span>
  </>;
}

/** Until the account adds credit, other console pages offer the same way forward. */
export function StartingCreditBanner({ billing }: { billing: Billing | undefined }) {
  if (!needsStartingCredit(billing)) return null;
  const card = billing!.startingCredit.cardCheck;
  return <Banner>
    <span>{card ? `Verify a card to get ${formatMicros(card.amount)} of starting credit, or add credit to start running agents.` : "Add credit to start running agents."}</span>
    <Button size="sm" asChild><Link to="billing">{card ? "Get started" : "Add credit"}</Link></Button>
  </Banner>;
}
