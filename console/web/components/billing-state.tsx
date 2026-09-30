import { useEffect, useRef, useState } from "react";
import { api, useApi, type AutoTopup, type Billing, type BillingAlerts, type BillingCard, type PaymentMethod } from "@/lib/api";

export const AUTO_PATH = "/v1/billing/auto-topup";
export const cardLabel = (card: BillingCard | null | undefined) => card ? `${card.brand.charAt(0).toUpperCase()}${card.brand.slice(1)} •• ${card.last4}` : "No card on file";
export const moneyInput = (value: string) => value.trim() !== "" && Number.isFinite(Number(value)) && Math.abs(Number(value) * 100 - Math.round(Number(value) * 100)) < 1e-6;
export const invoiceLink = (url: unknown) => typeof url === "string" && url.startsWith("https://") ? url : undefined;

/** One shared snapshot keeps the page, banners and sidebar consistent after a change. */
export function useBillingState(billing: ReturnType<typeof useApi<Billing>>) {
  const prepaid = billing.data?.billing === "prepaid";
  const auto = useApi<AutoTopup>(prepaid && billing.data?.checkout ? AUTO_PATH : undefined, 10_000);
  const alerts = useApi<BillingAlerts>(prepaid ? "/v1/billing/alerts" : undefined, 30_000);
  const payment = useApi<PaymentMethod>(prepaid && billing.data?.checkout ? "/v1/billing/payment-method" : undefined);
  const [dialog, setDialog] = useState<"add" | "auto" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const working = useRef(false);
  const refresh = async () => { await Promise.all([billing.reload(), auto.reload(), alerts.reload(), payment.reload()]); };
  async function portal(flow: "manage" | "payment_method", resumeAutoTopup = false) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(undefined);
    try { location.assign((await api<{ url: string }>("/v1/billing/portal", { body: { flow, resumeAutoTopup } })).url); }
    catch (e) { setError((e as Error).message); }
    finally { working.current = false; setBusy(false); }
  }
  async function retry() {
    if (working.current || !auto.data?.attempt?.canRetry) return;
    working.current = true; setBusy(true); setError(undefined);
    try { await api(`${AUTO_PATH}/retry`, { body: { attemptId: auto.data.attempt.id } }); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { working.current = false; setBusy(false); }
  }
  const previous = useRef(auto.data?.state);
  useEffect(() => {
    if (previous.current === "processing" && auto.data?.state !== "processing") void billing.reload();
    previous.current = auto.data?.state;
  }, [auto.data?.state, billing.reload]);
  return { billing, auto, alerts, payment, dialog, setDialog, busy, error, setError, notice, setNotice, refresh, portal, retry };
}
export type BillingState = ReturnType<typeof useBillingState>;
