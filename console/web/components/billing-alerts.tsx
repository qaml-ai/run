import { useState } from "react";
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
export function BillingAlertsSection() {
  const alerts = useApi<BillingAlerts>(PATH, 30_000);
  const [editing, setEditing] = useState(false);
  const data = alerts.data;
  return <section className="mb-6 border-y py-5">
    <div className="mb-2 flex items-center justify-between gap-4"><h2 className="text-sm font-medium">Alerts</h2><Button variant="outline" size="sm" disabled={!data} onClick={() => setEditing(true)}>Edit alerts</Button></div>
    <ErrorAlert error={alerts.error} />
    {!data ? <Skeleton className="h-10 w-64" /> : <>
      <p className="text-muted-foreground text-sm">When the balance drops below {formatMicros(data.threshold)}</p>
      {data.recipients.length ? <p className="mt-1 break-all text-sm">{data.recipients[0].email}{data.recipients.length > 1 && ` and ${data.recipients.length - 1} more`}</p>
        : <p className="bg-muted text-muted-foreground mt-3 px-3 py-2 text-sm">No alert email yet.</p>}
      {data.recipients.some(r => r.status === "bounced") && <p className="mt-3 bg-[var(--tint-danger)] px-3 py-2 text-sm">One or more alert addresses cannot receive email. Update them in Alerts.</p>}
      {editing && <AlertsDialog data={data} refresh={alerts.reload} close={() => setEditing(false)} />}
    </>}
  </section>;
}
function AlertsDialog({ data, refresh, close }: { data: BillingAlerts; refresh(): Promise<void>; close(): void }) {
  const [threshold, setThreshold] = useState(String(data.threshold / 1e6));
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true); setError(undefined); setNotice(undefined);
    try { await api(path, { method, body }); await refresh(); return true; }
    catch (error) { setError((error as Error).message); return false; }
    finally { setBusy(false); }
  }
  async function add() {
    if (await mutate(`${PATH}/recipients`, "POST", { email: email.trim() })) { setEmail(""); setNotice("Confirmation email queued."); }
  }
  async function save() {
    if (await mutate(PATH, "PUT", { thresholdUsd: Number(threshold) })) close();
  }
  async function select(recipient: BillingRecipient, key: keyof AlertChoices, enabled: boolean) {
    await mutate(`${PATH}/recipients/${recipient.id}`, "PUT", { ...recipient.events, [key]: enabled });
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>Alerts</DialogTitle><DialogDescription>Choose who gets each billing email.</DialogDescription></DialogHeader>
    <ErrorAlert error={error} />
    {notice && <p role="status" className="bg-[var(--tint-info)] px-3 py-2 text-sm">{notice}</p>}
    <div className="grid gap-2"><Label htmlFor="alert-threshold">Low balance below (USD)</Label><Input id="alert-threshold" className="max-w-40" type="number" min="0.01" max="500" step="0.01" value={threshold} onChange={e => setThreshold(e.target.value)} /></div>
    <div className="divide-y border-y">
      {data.recipients.map(recipient => <div key={recipient.id} className="py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2"><span className="min-w-0 flex-1 break-all text-sm">{recipient.email}</span>
          {recipient.status !== "verified" && <Badge variant={recipient.status === "bounced" ? "destructive" : "secondary"}>{recipient.status === "bounced" ? "Bouncing" : "Not confirmed"}</Badge>}
          {recipient.status === "pending" && <Button variant="link" size="sm" disabled={busy || !data.emailEnabled} onClick={async () => { if (await mutate(`${PATH}/recipients/${recipient.id}/resend`, "POST", {})) setNotice("Confirmation email queued."); }}>Resend</Button>}
          <Button variant="ghost" size="sm" aria-label={`Remove ${recipient.email}`} disabled={busy} onClick={() => void mutate(`${PATH}/recipients/${recipient.id}`, "DELETE")}>Remove</Button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">{CHOICES.map(([key, label]) => <label key={key} className="flex items-center gap-2 text-xs"><input type="checkbox" className="size-4 accent-foreground" checked={recipient.events[key]} disabled={busy} onChange={e => void select(recipient, key, e.target.checked)} />{label}</label>)}</div>
      </div>)}
      {!data.recipients.length && <p className="text-muted-foreground py-4 text-sm">No recipients added.</p>}
    </div>
    {data.emailEnabled ? data.recipients.length < 5 && <div className="grid gap-2"><Label htmlFor="alert-email">Add email</Label><div className="flex gap-2"><Input id="alert-email" type="email" placeholder="billing@example.com" value={email} disabled={busy} onChange={e => setEmail(e.target.value)} /><Button disabled={busy || !email.trim()} onClick={() => void add()}>Add</Button></div></div>
      : <p className="bg-muted text-muted-foreground px-3 py-2 text-sm">Email alerts aren't available on this runtime.</p>}
    <p className="text-muted-foreground text-xs">Each address confirms by email first. Recipient changes save immediately.</p>
    <DialogFooter><Button variant="outline" disabled={busy} onClick={close}>Close</Button><Button disabled={busy || !threshold} onClick={() => void save()}>Save threshold</Button></DialogFooter>
  </DialogContent></Dialog>;
}
