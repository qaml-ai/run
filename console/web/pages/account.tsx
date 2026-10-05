import { useState, type FormEvent } from "react";
import { Download, Loader2, LogOut, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatMicros, signedInWithToken, useApi, type Billing, type Me } from "@/lib/api";

/**
 * The credit a deletion forfeits, split as it was paid for: the balance is one pool, and free credit
 * (grants) counts as spent first, so what is left is purchased credit up to what was bought.
 */
export function forfeited(billing: Pick<Billing, "balance" | "purchased">) {
  const balance = Math.max(0, billing.balance);
  const purchased = Math.min(balance, Math.max(0, billing.purchased));
  return { purchased, free: balance - purchased };
}

function Forfeited() {
  const billing = useApi<Billing>("/v1/billing");
  const credit = billing.data?.billing === "prepaid" ? forfeited(billing.data) : undefined;
  return (
    <div className="border-destructive/40 border p-3 text-sm">
      {billing.loading ? <p className="text-muted-foreground">Checking your credit…</p> : credit && credit.purchased + credit.free > 0 ? <>
        <p className="font-medium">Your remaining credit is forfeited, and is not refunded:</p>
        <ul className="mt-1 font-mono text-xs">
          <li>Purchased credit: {formatMicros(credit.purchased)}</li>
          <li>Free credit: {formatMicros(credit.free)}</li>
        </ul>
      </> : <p>You have no remaining credit to forfeit.</p>}
      <p className="text-muted-foreground mt-2 text-xs">Questions about your credit? Write to <a className="underline" href="mailto:support@camelai.com">support@camelai.com</a> before deleting.</p>
    </div>
  );
}

/** What the person types to confirm: the same for every account, since sign-in ids (`u-…`) mean nothing to people. */
export const DELETE_PHRASE = "delete my account";

function DeleteAccountDialog({ tenant, onClose }: { tenant: string; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function remove(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await api("/v1/account", { method: "DELETE", body: { confirm: tenant } });
      // The account no longer signs in: end the session and say what happened.
      await api("/console/auth/logout", { body: {} }).catch(() => {});
      location.assign("/console/?deleted=1");
    } catch (caught) { setError((caught as Error).message); setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <form onSubmit={remove} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription>
              This deletes every agent and its history, your volumes and files, definitions, channels, webhooks, API tokens,
              connected apps and saved keys, and your saved payment cards. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <Forfeited />
          <ErrorAlert error={error} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="delete-confirm">Type <span className="font-mono">{DELETE_PHRASE}</span> to confirm</Label>
            <Input id="delete-confirm" autoFocus autoComplete="off" value={typed} onChange={event => setTyped(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" variant="destructive" disabled={typed.trim().toLowerCase() !== DELETE_PHRASE || busy}>{busy && <Loader2 className="animate-spin" />}Delete account</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Every console session of the account ends, this one too: then back to sign-in. */
function SignOutEverywhere() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <section className="bg-card mb-6 border p-5">
      <h2 className="text-base font-semibold">Sign out everywhere</h2>
      <p className="text-muted-foreground mt-1 mb-4 max-w-2xl text-sm">
        Ends every console session of this account, on every browser and device, including this one. API tokens and connected apps keep working;
        revoke those under API tokens.
      </p>
      <ErrorAlert error={error} />
      <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
        setBusy(true); setError(undefined);
        try { await api("/v1/sessions", { method: "DELETE" }); location.assign("/console/"); }
        catch (caught) { setError((caught as Error).message); setBusy(false); }
      }}>{busy ? <Loader2 className="animate-spin" /> : <LogOut />}Sign out everywhere</Button>
    </section>
  );
}

export function AccountPage({ me }: { me: Pick<Me, "tenant"> & Partial<Pick<Me, "via" | "signIn">> }) {
  const [deleting, setDeleting] = useState(false);
  const withToken = signedInWithToken({ via: me.via ?? "console", signIn: me.signIn });
  return (
    <>
      <PageHeader title="Account" description="Take a copy of your data, or delete your account." />
      <div className="text-muted-foreground mb-6 flex flex-wrap items-center gap-2 text-xs">
        <span>Account ID</span><code className="text-foreground font-mono">{me.tenant}</code><CopyButton value={me.tenant} label="Copy account ID" />
      </div>
      <section className="bg-card mb-6 border p-5">
        <h2 className="text-base font-semibold">Export your data</h2>
        <p className="text-muted-foreground mt-1 mb-4 max-w-2xl text-sm">
          A zip of everything the account stores: each agent's configuration and full history, your definitions, channels and webhooks,
          every volume's files, and your credit ledger and usage. Keys and secrets are left out. Large accounts take a while to download.
        </p>
        <Button asChild size="sm" variant="outline"><a href="/v1/account/export" download><Download />Export data</a></Button>
      </section>
      <SignOutEverywhere />
      <section className="bg-card border-destructive/40 border p-5">
        <h2 className="text-base font-semibold">Delete your account</h2>
        <p className="text-muted-foreground mt-1 mb-4 max-w-2xl text-sm">
          Deletes the account and everything in it, and signs you out. Your credit ledger and usage totals are kept for tax and accounting,
          and a record that starting credit was given, so a new account for the same GitHub account or card gets none. Signing in again
          later makes a new, empty account.
        </p>
        {withToken
          ? <p className="text-sm">You signed in with a token: sign in with GitHub or Google to delete the account.</p>
          : <Button size="sm" variant="destructive" onClick={() => setDeleting(true)}><Trash2 />Delete account</Button>}
      </section>
      {deleting && <DeleteAccountDialog tenant={me.tenant} onClose={() => setDeleting(false)} />}
    </>
  );
}
