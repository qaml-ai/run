import { useEffect, useState } from "react";
import { accountLabel, api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { PixelButton } from "@/components/ui/pixel-button";
import { FullLogo } from "@/components/ui/logo";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorAlert } from "@/components/common";
import { PIXEL_STYLE } from "@/components/brand";

type State = { status: "unavailable" } | { status: "ready" | "confirmed"; tenant: string; email: string };
export function BillingConfirmationPage() {
  const [token] = useState(() => location.hash.slice(1));
  const [state, setState] = useState<State>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Fragments never reach server logs or referrers. Keeping the fragment lets
    // reloads and temporary network failures recover without browser storage.
    void api<State>("/v1/billing/alerts/confirmation/inspect", { body: { token } }).then(setState, error => setError(error.message));
  }, [token]);
  async function confirm() {
    setBusy(true); setError(undefined);
    try { setState(await api<State>("/v1/billing/alerts/confirmation/confirm", { body: { token } })); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-6 py-16">
    <FullLogo className="mb-12 h-7 w-auto self-start" />
    <p style={PIXEL_STYLE} className="text-muted-foreground mb-4 text-[10px] tracking-[0.2em]">CAMELRUN · BILLING ALERTS</p>
    <ErrorAlert error={error} />
    {!state ? <Skeleton className="h-36 w-full" /> : state.status === "unavailable" ? <>
      <h1 className="mb-4 text-2xl font-semibold">This link doesn't work anymore</h1>
      <p className="text-muted-foreground text-sm leading-6">Confirmation links last 24 hours, and only the newest one works. Ask someone on the account to resend it from Billing.</p>
    </> : state.status === "confirmed" ? <>
      <Badge variant="info" className="mb-4">Confirmed</Badge>
      <h1 className="mb-4 text-2xl font-semibold">You're set</h1>
      <p className="text-muted-foreground text-sm leading-6"><span className="text-foreground break-all">{state.email}</span> will get billing alerts for {accountLabel(state.tenant) ? <strong className="text-foreground">{accountLabel(state.tenant)}</strong> : "a camelRun account"}. Choose which alerts it gets in Billing.</p>
    </> : <>
      <h1 className="mb-4 text-2xl font-semibold">Confirm billing alerts</h1>
      <p className="text-muted-foreground mb-7 text-sm leading-6">Send billing alerts for {accountLabel(state.tenant) ? <strong className="text-foreground">{accountLabel(state.tenant)}</strong> : "a camelRun account"} to <span className="text-foreground break-all">{state.email}</span>?</p>
      <PixelButton size="hero" className="self-start" disabled={busy} loading={busy} onClick={() => void confirm()}>Confirm</PixelButton>
      <p className="text-muted-foreground mt-6 text-xs leading-5">Didn't expect this? Close this page, and nothing else is sent.</p>
    </>}
  </main>;
}
