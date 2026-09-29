import { useState, type FormEvent } from "react";
import { KeyRound, Loader2, Plug, Plus } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PixelButton } from "@/components/ui/pixel-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FirstRunPanel } from "@/components/brand";
import { CodeBlock, ConfirmButton, CopyButton, EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatTime, useApi, type ApiToken, type OAuthGrant } from "@/lib/api";

function CreateTokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try { setCreated((await api<{ token: string }>("/v1/tokens", { body: { name: name.trim() } })).token); onCreated(); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        {created ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Copy your token now</DialogTitle>
              <DialogDescription>It won't be shown again. Anyone with it can create and control every agent in your tenant.</DialogDescription>
            </DialogHeader>
            <div className="bg-card border-foreground/40 border p-3">
              <div className="flex items-center justify-between gap-2"><Eyebrow>SHOWN ONCE</Eyebrow><CopyButton value={created} label="Copy token" /></div>
              <code className="mt-1 block font-mono text-xs leading-relaxed break-all">{created}</code>
            </div>
            <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
          </div>
        ) : (
          <form onSubmit={create} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>New API token</DialogTitle>
              <DialogDescription>Use it as the SDK's <code className="font-mono">apiKey</code>, or as <code className="font-mono">Authorization: Bearer</code> for the REST API.</DialogDescription>
            </DialogHeader>
            <ErrorAlert error={error} />
            <div className="flex flex-col gap-2">
              <Label htmlFor="token-name">Name</Label>
              <Input id="token-name" autoFocus placeholder="e.g. production backend" value={name} onChange={event => setName(event.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={!name.trim() || busy}>{busy && <Loader2 className="animate-spin" />}Create token</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function TokensPage() {
  const tokens = useApi<ApiToken[]>("/v1/tokens");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <>
      <PageHeader title="API tokens" description="Tokens for your applications and scripts. Each one has full access to your tenant; revoke any you no longer use."
        actions={<Button size="sm" onClick={() => setCreating(true)}><Plus />New token</Button>} />
      <ErrorAlert error={tokens.error ?? error} />
      <Alert className="mb-4">
        <KeyRound />
        <AlertTitle>Keep tokens on your backend</AlertTitle>
        <AlertDescription>Never ship a token to a browser or mobile app. Your backend creates agents and hands clients only an agent's scoped session.</AlertDescription>
      </Alert>
      {!tokens.data ? <Skeleton className="h-32 w-full" /> : tokens.data.length === 0 ? (
        <FirstRunPanel art="aurora" eyebrow="FIRST TOKEN" title="No API tokens"
          action={<PixelButton onClick={() => setCreating(true)}>New token</PixelButton>}>
          Create one to connect your application.
        </FirstRunPanel>
      ) : (
        <div className="bg-card border">
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Token</TableHead><TableHead>Created</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {tokens.data.map(token => (
                <TableRow key={token.id}>
                  <TableCell className="font-medium">{token.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">{token.prefix}…</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{formatTime(token.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <ConfirmButton size="xs" label="Revoke" title={`Revoke “${token.name}”?`} description="Applications using this token stop working immediately." confirm="Revoke token"
                      onConfirm={async () => { try { await api(`/v1/tokens/${token.id}`, { method: "DELETE" }); await tokens.reload(); } catch (caught) { setError((caught as Error).message); } }} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ConnectedApps />
      {creating && <CreateTokenDialog onClose={() => setCreating(false)} onCreated={() => void tokens.reload()} />}
    </>
  );
}

/** Applications connected to the hosted MCP endpoint with OAuth (Claude, Cursor, …), each until revoked. */
function ConnectedApps() {
  const grants = useApi<OAuthGrant[]>("/v1/oauth/grants");
  const [error, setError] = useState<string>();
  const url = `${window.location.origin}/mcp`;
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold">Connected apps</h2>
      <p className="text-muted-foreground mb-4 text-sm">Coding agents and assistants connect to Camel Run's MCP server at the URL below and sign in here. Each one you allow acts as your tenant, like an API token, until you revoke it. A browser with WebMCP gets the same tools from this page while you are signed in.</p>
      <CodeBlock code={url} />
      <ErrorAlert error={grants.error ?? error} />
      {!grants.data ? <Skeleton className="mt-4 h-24 w-full" /> : grants.data.length === 0 ? (
        <div className="mt-4"><EmptyState icon={<Plug />} title="No connected apps">Add the URL above as a remote MCP server in your client, then sign in when it asks.</EmptyState></div>
      ) : (
        <div className="mt-4 rounded-lg border">
          <Table>
            <TableHeader><TableRow><TableHead>App</TableHead><TableHead>Allowed by</TableHead><TableHead>Connected</TableHead><TableHead>Last used</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {grants.data.map(grant => (
                <TableRow key={grant.id}>
                  <TableCell className="font-medium">{grant.clientName}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{grant.login ?? "API token sign-in"}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{formatTime(grant.createdAt)}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{grant.usedAt ? formatTime(grant.usedAt) : "-"}</TableCell>
                  <TableCell className="text-right">
                    <ConfirmButton size="xs" label="Revoke" title={`Disconnect “${grant.clientName}”?`} description="It loses access within seconds, and must be connected again to come back." confirm="Revoke"
                      onConfirm={async () => { try { await api(`/v1/oauth/grants/${grant.id}`, { method: "DELETE" }); await grants.reload(); } catch (caught) { setError((caught as Error).message); } }} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
