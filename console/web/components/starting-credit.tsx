import { useApi, type Billing } from "@/lib/api";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";

export function needsStartingCredit(data: Billing | undefined) {
  return !!data && data.billing === "prepaid" && data.balance <= 0 && data.freeCredit &&
    (data.startingCredit?.status === "not_eligible" || data.startingCredit?.status === "not_granted");
}

export function StartingCreditHelp({ status }: { status: Billing["startingCredit"]["status"] }) {
  return <>
    {status === "not_eligible" ? "This account doesn't qualify for starting credit." : "This account has no starting credit."}
    {" "}Add credit to start running agents.
    <span className="mt-1 block">If you think this is a mistake, email{" "}
      <a href="mailto:support@camelai.com" className="text-foreground underline underline-offset-4">support@camelai.com</a>.
    </span>
  </>;
}

/** Until the account adds credit, other console pages offer the same way forward. */
export function StartingCreditBanner() {
  const billing = useApi<Billing>("/v1/billing", 30_000);
  if (!needsStartingCredit(billing.data)) return null;
  return <div role="status" className="bg-muted mb-6 flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
    <span>Add credit to start running agents.</span>
    <Button size="sm" asChild><Link to="billing">Add credit</Link></Button>
  </div>;
}
