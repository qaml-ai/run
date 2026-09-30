import { useEffect, useState } from "react";
import { accountLabel, api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { PixelButton } from "@/components/ui/pixel-button";
import { FullLogo } from "@/components/ui/logo";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorAlert } from "@/components/common";
import { PIXEL_STYLE } from "@/components/brand";

type State = { status: "unavailable" } | { status: "ready" | "unsubscribed"; tenant: string; email: string };
export function BillingUnsubscribePage() {
  const [token] = useState(() => location.hash.slice(1));
  const [state, setState] = useState<State>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<State>("/v1/billing/alerts/unsubscribe/inspect", { body: { token } }).then(setState, e => setError(e.message)); }, [token]);
  async function stop() {
    setBusy(true); setError(undefined);
    try { setState(await api<State>("/v1/billing/alerts/unsubscribe/stop", { body: { token } })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-6 py-16">
    <FullLogo className="mb-12 h-7 w-auto self-start" />
    <p style={PIXEL_STYLE} className="text-muted-foreground mb-4 text-[10px] tracking-[0.2em]">CAMELRUN · BILLING ALERTS</p>
    <ErrorAlert error={error} />
    {!state ? <Skeleton className="h-36 w-full" /> : state.status === "unavailable" ? <>
      <h1 className="mb-4 text-2xl font-semibold">This link doesn't work anymore</h1>
      <p className="text-muted-foreground text-sm leading-6">Try the link in your latest billing email, or contact support@camelai.com.</p>
    </> : state.status === "unsubscribed" ? <>
      <Badge variant="info" className="mb-4">Stopped</Badge><h1 className="mb-4 text-2xl font-semibold">Billing alerts stopped</h1>
      <p className="text-muted-foreground text-sm leading-6"><span className="text-foreground break-all">{state.email}</span> won't receive more billing alerts for {accountLabel(state.tenant) ? <strong className="text-foreground">{accountLabel(state.tenant)}</strong> : "a camelRun account"}. An email already on its way may still arrive.</p>
    </> : <>
      <h1 className="mb-4 text-2xl font-semibold">Stop billing alerts?</h1>
      <p className="text-muted-foreground mb-7 text-sm leading-6">Stop sending billing alerts for {accountLabel(state.tenant) ? <strong className="text-foreground">{accountLabel(state.tenant)}</strong> : "a camelRun account"} to <span className="text-foreground break-all">{state.email}</span>.</p>
      <PixelButton size="hero" className="self-start" disabled={busy} loading={busy} onClick={() => void stop()}>Stop these alerts</PixelButton>
      <p className="text-muted-foreground mt-6 text-xs leading-5">Your other accounts and payment settings stay the same.</p>
    </>}
  </main>;
}
