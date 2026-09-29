import { type Billing } from "@/lib/api";
import { Link } from "@/lib/router";
import { Banner } from "@/components/banner";
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
export function StartingCreditBanner({ billing }: { billing: Billing | undefined }) {
  if (!needsStartingCredit(billing)) return null;
  return <Banner>
    <span>Add credit to start running agents.</span>
    <Button size="sm" asChild><Link to="billing">Add credit</Link></Button>
  </Banner>;
}
