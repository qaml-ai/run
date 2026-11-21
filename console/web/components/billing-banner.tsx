import { Banner } from "@/components/banner";
import { Button } from "@/components/ui/button";
import { formatUsd, type Billing } from "@/lib/api";
import { Link } from "@/lib/router";

export function BillingBanner({ billing, hide }: { billing?: Billing; hide?: boolean }) {
  if (!billing || hide) return null;
  if (billing.balanceUsd <= 0) {
    return (
      <Banner danger>
        <span>Your balance is empty ({formatUsd(billing.balanceUsd)}). Runs using platform-billed models may be paused.</span>
        <Button size="sm" variant="outline" asChild>
          <Link to="billing">View billing</Link>
        </Button>
      </Banner>
    );
  }
  if (billing.balanceUsd < 2) {
    return (
      <Banner>
        <span>Your balance is low: {formatUsd(billing.balanceUsd)}.</span>
        <Button size="sm" variant="outline" asChild>
          <Link to="billing">View billing</Link>
        </Button>
      </Banner>
    );
  }
  return null;
}

export function BillingBalance({ billing, mobile = false }: { billing?: Billing; mobile?: boolean }) {
  if (!billing) return null;
  const danger = billing.balanceUsd <= 0;
  const low = billing.balanceUsd < 2;
  return (
    <Link to="billing" className={mobile ? "block text-right" : "hover:bg-sidebar-accent block border-b px-5 py-3"}>
      <span className="text-muted-foreground text-xs">Balance</span>
      <span className={`flex items-center gap-2 font-mono ${mobile ? "justify-end text-sm" : "text-lg"}`}>
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 ${danger ? "bg-destructive" : low ? "border border-foreground" : "bg-[var(--chart-1)]"}`}
        />
        {formatUsd(billing.balanceUsd)}
      </span>
    </Link>
  );
}
