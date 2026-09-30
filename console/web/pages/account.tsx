import { useState, type FormEvent } from "react";
import { Download, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton, ErrorAlert, PageHeader } from "@/components/common";
import { api, type Me } from "@/lib/api";

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
              connected apps and saved keys, and your saved payment cards. It cannot be undone. Remaining credit is forfeited.
            </DialogDescription>
          </DialogHeader>
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

export function AccountPage({ me }: { me: Pick<Me, "tenant"> }) {
  const [deleting, setDeleting] = useState(false);
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
      <section className="bg-card border-destructive/40 border p-5">
        <h2 className="text-base font-semibold">Delete your account</h2>
        <p className="text-muted-foreground mt-1 mb-4 max-w-2xl text-sm">
          Deletes the account and everything in it, and signs you out. Your credit ledger and usage totals are kept for tax and accounting,
          and a record that starting credit was given, so a new account for the same GitHub account or card gets none. Signing in again
          later makes a new, empty account.
        </p>
        <Button size="sm" variant="destructive" onClick={() => setDeleting(true)}><Trash2 />Delete account</Button>
      </section>
      {deleting && <DeleteAccountDialog tenant={me.tenant} onClose={() => setDeleting(false)} />}
    </>
  );
}
