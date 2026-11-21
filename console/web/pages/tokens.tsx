import { useState, type FormEvent } from "react";
import { KeyRound, Loader2, Plus } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PixelButton } from "@/components/ui/pixel-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FirstRunPanel } from "@/components/brand";
import { ConfirmButton, CopyButton, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatAgo, formatTime, useApi, type ApiToken } from "@/lib/api";

function CreateTokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ token: string }>("/v2/tokens", { method: "POST", body: { name: name.trim() } });
      setCreated(res.token);
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
        {created ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Copy your key now</DialogTitle>
              <DialogDescription>
                It won&apos;t be shown again. Anyone with this <code className="font-mono">cr_live_*</code> key can create and control every agent in your tenant.
              </DialogDescription>
            </DialogHeader>
            <div className="bg-card border-foreground/40 border p-3">
              <div className="flex items-center justify-between gap-2">
                <Eyebrow>SHOWN ONCE</Eyebrow>
                <CopyButton value={created} label="Copy key" />
              </div>
              <code className="mt-1 block font-mono text-xs leading-relaxed break-all">{created}</code>
            </div>
            <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
          </div>
        ) : (
          <form onSubmit={create} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>
                Send it as <code className="font-mono">Authorization: Bearer cr_live_…</code> against <code className="font-mono">/v2/*</code>.
              </DialogDescription>
            </DialogHeader>
            <ErrorAlert error={error} />
            <div className="flex flex-col gap-2">
              <Label htmlFor="token-name">Name</Label>
              <Input
                id="token-name"
                autoFocus
                placeholder="e.g. production backend"
                value={name}
                onChange={event => setName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={!name.trim() || busy}>
                {busy && <Loader2 className="animate-spin" />}Create key
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AccountId({ tenant }: { tenant: string }) {
  return (
    <div className="text-muted-foreground mb-4 flex flex-wrap items-center gap-2 text-xs">
      <span>Tenant ID</span>
      <code className="text-foreground font-mono">{tenant}</code>
      <CopyButton value={tenant} label="Copy tenant ID" />
    </div>
  );
}

export function TokensPage({ tenant }: { tenant: string }) {
  const tokensRes = useApi<{ tokens: ApiToken[] }>("/v2/tokens");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const tokens = tokensRes.data?.tokens;

  return (
    <>
      <PageHeader
        title="API keys"
        docs="authentication"
        description="Tenant keys (cr_live_*) for your applications and scripts. Each key grants full access to your tenant; revoke any you no longer use."
        actions={<Button size="sm" onClick={() => setCreating(true)}><Plus />New key</Button>}
      />
      <ErrorAlert error={tokensRes.error ?? error} />
      <AccountId tenant={tenant} />
      <Alert className="mb-4">
        <KeyRound />
        <AlertTitle>Keep keys on your backend</AlertTitle>
        <AlertDescription>
          Never ship a tenant key to a browser or mobile app. Your backend creates agents via <code className="font-mono">PUT /v2/agents/:key</code> and hands clients only the agent&apos;s scoped <code className="font-mono">agt_tok_*</code> token.
        </AlertDescription>
      </Alert>
      {!tokens ? (
        <Skeleton className="h-32 w-full" />
      ) : tokens.length === 0 ? (
        <FirstRunPanel
          art="aurora"
          eyebrow="FIRST KEY"
          title="No API keys"
          action={<PixelButton size="hero" onClick={() => setCreating(true)}>New key</PixelButton>}
        >
          Your application uses a key to create and run agents on CamelRun v2. Create one to connect it.
        </FirstRunPanel>
      ) : (
        <div className="bg-card border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead className="hidden sm:table-cell">Scopes</TableHead>
                <TableHead className="hidden md:table-cell">Last used</TableHead>
                <TableHead>Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map(token => (
                <TableRow key={token.id}>
                  <TableCell className="font-medium">{token.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">{token.prefix}</TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {(token.scopes ?? ["*"]).map(s => <Badge key={s} variant="outline">{s}</Badge>)}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-xs md:table-cell">
                    {token.lastUsedAt ? formatAgo(token.lastUsedAt) : "Never"}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{formatTime(token.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <ConfirmButton
                      size="xs"
                      label="Revoke"
                      title={`Revoke “${token.name}”?`}
                      description="Applications using this key stop working immediately."
                      confirm="Revoke key"
                      onConfirm={async () => {
                        try {
                          await api(`/v2/tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
                          await tokensRes.reload();
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
        <CreateTokenDialog
          onClose={() => setCreating(false)}
          onCreated={() => void tokensRes.reload()}
        />
      )}
    </>
  );
}
