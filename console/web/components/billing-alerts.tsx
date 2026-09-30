import { useRef, useState } from "react";
import { api, formatMicros, useApi, type BillingAlerts, type BillingRecipient, type AlertChoices } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorAlert } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";

const CHOICES: [keyof AlertChoices, string][] = [["low", "Low balance"], ["depleted", "Out of credit"], ["problems", "Top-up issues"], ["receipts", "Receipts"]];
const PATH = "/v1/billing/alerts";
export function BillingAlertsSection({ alerts }: { alerts: ReturnType<typeof useApi<BillingAlerts>> }) {
  const [editing, setEditing] = useState(false);
  const data = alerts.data;
  return <section className="border-b py-5">
    <div className="mb-2 flex items-center justify-between gap-4"><h2 className="text-sm font-medium">Alerts</h2><Button variant="outline" size="sm" disabled={!data} onClick={() => setEditing(true)}>Edit</Button></div>
    <ErrorAlert error={alerts.error} />
    {!data ? <Skeleton className="h-10 w-64" /> : <>
      <p className="text-muted-foreground text-sm">When the balance drops below {formatMicros(data.threshold)}</p>
      {data.recipients.length ? <p className="mt-1 break-all text-sm">{data.recipients[0].email}{data.recipients.length > 1 && ` and ${data.recipients.length - 1} more`}</p>
        : <p className="bg-muted text-muted-foreground mt-3 px-3 py-2 text-sm">No alert email yet, so alerts only show here in the console. <button className="text-foreground underline underline-offset-4" onClick={() => setEditing(true)}>Add email</button></p>}
      {data.recipients.some(r => r.status === "bounced") && <p className="mt-3 bg-[var(--tint-danger)] px-3 py-2 text-sm">Emails to {data.recipients.filter(r => r.status === "bounced").map(r => r.email).join(", ")} are bouncing. <button className="underline underline-offset-4" onClick={() => setEditing(true)}>Fix</button></p>}
      {editing && <AlertsDialog data={data} refresh={alerts.reload} close={() => setEditing(false)} />}
    </>}
  </section>;
}
function AlertsDialog({ data, refresh, close }: { data: BillingAlerts; refresh(): Promise<void>; close(): void }) {
  const [threshold, setThreshold] = useState(String(data.threshold / 1e6));
  const savedThreshold = useRef(data.threshold / 1e6);
  const working = useRef(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  async function mutate(path: string, method: string, body?: unknown) {
    if (working.current) return false;
    working.current = true;
    setBusy(true); setError(undefined); setNotice(undefined);
    try { await api(path, { method, body }); await refresh(); return true; }
    catch (error) { setError((error as Error).message); return false; }
    finally { working.current = false; setBusy(false); }
  }
  async function add() {
    if (await mutate(`${PATH}/recipients`, "POST", { email: email.trim() })) { setEmail(""); setNotice("Confirmation email queued."); }
  }
  async function save() {
    if (working.current) return false;
    const value = Number(threshold);
    if (!Number.isFinite(value) || value < 0.01 || value > 500 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
      setError("Choose a threshold from $0.01 to $500, in whole cents.");
      return false;
    }
    if (value === savedThreshold.current) return true;
    if (!await mutate(PATH, "PUT", { thresholdUsd: value })) return false;
    savedThreshold.current = value;
    return true;
  }
  async function finish() { if (await save()) close(); }
  async function select(recipient: BillingRecipient, key: keyof AlertChoices, enabled: boolean) {
    await mutate(`${PATH}/recipients/${recipient.id}`, "PUT", { ...recipient.events, [key]: enabled });
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) void finish(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>Alerts</DialogTitle><DialogDescription>Choose who gets each billing email.</DialogDescription></DialogHeader>
    <ErrorAlert error={error} />
    {notice && <p role="status" className="bg-[var(--tint-info)] px-3 py-2 text-sm">{notice}</p>}
    <div className="grid gap-2"><Label htmlFor="alert-threshold">Low balance below</Label><div className="relative max-w-40"><span aria-hidden="true" className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">$</span><Input id="alert-threshold" className="pl-7" inputMode="decimal" disabled={busy} value={threshold} onChange={e => setThreshold(e.target.value.replace(/[^0-9.]/g, ""))} onBlur={() => { void save(); }} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} /></div></div>
    <div className="divide-y border-y">
      {data.recipients.map(recipient => <div key={recipient.id} className="py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2"><span className="min-w-0 flex-1 break-all text-sm">{recipient.email}</span>
          {recipient.status !== "verified" && <Badge variant={recipient.status === "bounced" ? "destructive" : "secondary"}>{recipient.status === "bounced" ? "Bouncing" : recipient.status === "unsubscribed" ? "Stopped" : "Not confirmed"}</Badge>}
          {["pending", "unsubscribed"].includes(recipient.status) && <Button variant="link" size="sm" disabled={busy || !data.emailEnabled} onClick={async () => { if (await mutate(`${PATH}/recipients/${recipient.id}/resend`, "POST", {})) setNotice("Confirmation email queued."); }}>{recipient.status === "unsubscribed" ? "Request confirmation" : "Resend"}</Button>}
          <Button variant="ghost" size="sm" aria-label={`Remove ${recipient.email}`} disabled={busy} onClick={() => void mutate(`${PATH}/recipients/${recipient.id}`, "DELETE")}>Remove</Button>
        </div>
        {recipient.status === "unsubscribed" && <p className="text-muted-foreground mt-2 text-xs">Alerts resume after this address confirms again.</p>}
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">{CHOICES.map(([key, label]) => <label key={key} className="flex items-center gap-2 text-xs"><input type="checkbox" className="size-4 accent-foreground" checked={recipient.events[key]} disabled={busy || recipient.status === "unsubscribed"} onChange={e => void select(recipient, key, e.target.checked)} />{label}</label>)}</div>
      </div>)}
      {!data.recipients.length && <p className="text-muted-foreground py-4 text-sm">No recipients added.</p>}
    </div>
    {data.emailEnabled ? data.recipients.length < 5 && <div className="grid gap-2"><Label htmlFor="alert-email">Add email</Label><div className="flex gap-2"><Input id="alert-email" type="email" placeholder="billing@example.com" value={email} disabled={busy} onChange={e => setEmail(e.target.value)} /><Button disabled={busy || !email.trim()} onClick={() => void add()}>Add</Button></div></div>
      : <p className="bg-muted text-muted-foreground px-3 py-2 text-sm">Email alerts aren't available on this runtime.</p>}
    <p className="text-muted-foreground text-xs">Each address confirms by email first. Invoices come from Stripe. Changes save automatically.</p>
    <DialogFooter><Button disabled={busy} onMouseDown={e => e.preventDefault()} onClick={() => void finish()}>Done</Button></DialogFooter>
  </DialogContent></Dialog>;
}
