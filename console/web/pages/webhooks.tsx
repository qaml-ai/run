import { useState, type FormEvent } from "react";
import { Loader2, Plus, Webhook as WebhookIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmButton, CopyButton, EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatTime, useApi, type Webhook } from "@/lib/api";

function CreateWebhookDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [url, setUrl] = useState("");
  const [eventsText, setEventsText] = useState("*");
  const [secret, setSecret] = useState("");
  const [createdSecret, setCreatedSecret] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const events = eventsText.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    setBusy(true);
    setError(undefined);
    try {
      const created = await api<Webhook & { secret: string }>("/v2/webhooks", {
        method: "POST",
        body: {
          url: url.trim(),
          events: events.length ? events : ["*"],
          ...(secret.trim() ? { secret: secret.trim() } : {}),
        },
      });
      setCreatedSecret(created.secret);
      onCreated();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        {createdSecret ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Copy your webhook signing secret</DialogTitle>
              <DialogDescription>
                Deliveries include an HMAC-SHA256 signature in <code className="font-mono">X-CamelRun-Signature</code>. This secret is shown once.
              </DialogDescription>
            </DialogHeader>
            <div className="bg-card border-foreground/40 border p-3">
              <div className="flex items-center justify-between gap-2">
                <Eyebrow>SHOWN ONCE</Eyebrow>
                <CopyButton value={createdSecret} label="Copy signing secret" />
              </div>
              <code className="mt-1 block font-mono text-xs leading-relaxed break-all">{createdSecret}</code>
            </div>
            <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>New webhook</DialogTitle>
              <DialogDescription>
                Receives signed JSON envelopes via Cloudflare Queues when agent runs complete, fail, or need input.
              </DialogDescription>
            </DialogHeader>
            <ErrorAlert error={error} />
            <div className="flex flex-col gap-2">
              <Label htmlFor="webhook-url">Endpoint URL</Label>
              <Input
                id="webhook-url"
                autoFocus
                placeholder="https://example.com/webhooks/camelrun"
                className="font-mono text-xs"
                value={url}
                onChange={event => setUrl(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="webhook-events">Events (comma-separated, or * for all)</Label>
              <Input
                id="webhook-events"
                className="font-mono text-xs"
                placeholder="* or run_completed, run_failed, input_required"
                value={eventsText}
                onChange={event => setEventsText(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="webhook-secret">Signing secret (optional — auto-generated if blank)</Label>
              <Input
                id="webhook-secret"
                type="password"
                autoComplete="off"
                value={secret}
                onChange={event => setSecret(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={busy || !url.trim().startsWith("http")}>
                {busy && <Loader2 className="animate-spin" />}Create webhook
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function WebhooksPage() {
  const webhooksRes = useApi<{ webhooks: Webhook[] }>("/v2/webhooks");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const webhooks = webhooksRes.data?.webhooks;

  return (
    <>
      <PageHeader
        title="Webhooks"
        docs="events"
        description="Signed HTTP callbacks delivered via Cloudflare Queues for agent lifecycle events."
        actions={<Button size="sm" onClick={() => setCreating(true)}><Plus />New webhook</Button>}
      />
      <ErrorAlert error={webhooksRes.error ?? error} />
      {!webhooks ? (
        <Skeleton className="h-32 w-full" />
      ) : webhooks.length === 0 ? (
        <EmptyState
          icon={<WebhookIcon />}
          title="No webhooks"
          action={<Button size="sm" onClick={() => setCreating(true)}><Plus />New webhook</Button>}
        >
          Add an HTTPS endpoint to receive signed <code className="font-mono">X-CamelRun-Signature</code> event deliveries whenever your agents finish runs or request input.
        </EmptyState>
      ) : (
        <div className="bg-card border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Endpoint</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {webhooks.map(hook => (
                <TableRow key={hook.id}>
                  <TableCell className="max-w-sm truncate font-mono text-xs">{hook.url}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(hook.events ?? ["*"]).map(ev => <Badge key={ev} variant="outline">{ev}</Badge>)}
                    </div>
                  </TableCell>
                  <TableCell>
                    {hook.enabled ? <Badge>Enabled</Badge> : <Badge variant="outline">Disabled</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-xs lg:table-cell">
                    {formatTime(hook.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <ConfirmButton
                      size="xs"
                      label="Delete"
                      title="Delete this webhook?"
                      description="CamelRun will stop sending event deliveries to this endpoint immediately."
                      confirm="Delete webhook"
                      onConfirm={async () => {
                        try {
                          await api(`/v2/webhooks/${encodeURIComponent(hook.id)}`, { method: "DELETE" });
                          await webhooksRes.reload();
                        } catch (caught) {
                          setError((caught as Error).message);
                        }
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {creating && (
        <CreateWebhookDialog
          onClose={() => setCreating(false)}
          onCreated={() => void webhooksRes.reload()}
        />
      )}
    </>
  );
}
