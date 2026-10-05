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

/** What a revoked token or app still has sending the account's data (webhooks, the trace export), to review. */
export type Left = { kind: "webhook" | "usage-webhook" | "telemetry"; id?: string; url: string }[];
function StillSending({ left }: { left?: Left }) {
  if (!left?.length) return null;
  return <Alert variant="destructive" className="mb-4">
    <AlertTitle>Still sending your data</AlertTitle>
    <AlertDescription>
      <p>The credential you revoked set these, and they keep sending until you change or delete them: webhooks with <code className="font-mono">PATCH</code> or <code className="font-mono">DELETE /v1/webhooks/&#123;id&#125;</code> (the usage webhook at <code className="font-mono">/v1/usage-webhook</code>), the trace export on the Telemetry page.</p>
      <ul className="mt-2 list-disc pl-5">{left.map(sink => <li key={`${sink.kind}:${sink.id ?? ""}`}><span className="font-medium">{sink.kind}</span>{sink.id ? <> <code className="font-mono text-xs">{sink.id}</code></> : null}: <code className="font-mono text-xs break-all">{sink.url}</code></li>)}</ul>
    </AlertDescription>
  </Alert>;
}

/** The account's id, for API calls and support: shown here only, never as who is signed in. */
function AccountId({ tenant }: { tenant: string }) {
  return <div className="text-muted-foreground mb-4 flex flex-wrap items-center gap-2 text-xs">
    <span>Account ID</span><code className="text-foreground font-mono">{tenant}</code><CopyButton value={tenant} label="Copy account ID" />
  </div>;
}

/** `canMint` is false for a console session signed in to with a token: only GitHub or Google sessions make tokens. */
export function TokensPage({ tenant, canMint = true }: { tenant: string; canMint?: boolean }) {
  const tokens = useApi<ApiToken[]>("/v1/tokens");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [left, setLeft] = useState<Left>();
  return (
    <>
      <PageHeader title="API tokens" description="Tokens for your applications and scripts. Each one has full access to your tenant; revoke any you no longer use."
        actions={canMint ? <Button size="sm" onClick={() => setCreating(true)}><Plus />New token</Button> : undefined} />
      <ErrorAlert error={tokens.error ?? error} />
      <StillSending left={left} />
      <AccountId tenant={tenant} />
      {!canMint && <Alert className="mb-4"><KeyRound /><AlertTitle>Signed in with a token</AlertTitle><AlertDescription>Sign in with GitHub or Google to create API tokens.</AlertDescription></Alert>}
      <Alert className="mb-4">
        <KeyRound />
        <AlertTitle>Keep tokens on your backend</AlertTitle>
        <AlertDescription>Never ship a token to a browser or mobile app. Your backend creates agents and hands clients only an agent's scoped session.</AlertDescription>
      </Alert>
      {!tokens.data ? <Skeleton className="h-32 w-full" /> : tokens.data.length === 0 ? (
        <FirstRunPanel art="aurora" eyebrow="FIRST TOKEN" title="No API tokens"
          action={canMint ? <PixelButton size="hero" onClick={() => setCreating(true)}>New token</PixelButton> : undefined}>
          {canMint ? "Create one to connect your application." : "Sign in with GitHub or Google to create one."}
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
                      onConfirm={async () => { try { setLeft((await api<{ left?: Left }>(`/v1/tokens/${token.id}`, { method: "DELETE" })).left); await tokens.reload(); } catch (caught) { setError((caught as Error).message); } }} />
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
  const [left, setLeft] = useState<Left>();
  const url = `${window.location.origin}/mcp`;
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold">Connected apps</h2>
      <p className="text-muted-foreground mb-4 text-sm">Coding agents and assistants connect to camelRun's MCP server at the URL below and sign in here. Each one you allow works with your agents and definitions until you revoke it; it cannot make tokens, webhooks or exports. A browser with WebMCP gets the same tools from this page while you are signed in.</p>
      <CodeBlock code={url} />
      <ErrorAlert error={grants.error ?? error} />
      <div className="mt-4"><StillSending left={left} /></div>
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
                      onConfirm={async () => { try { setLeft((await api<{ left?: Left }>(`/v1/oauth/grants/${grant.id}`, { method: "DELETE" })).left); await grants.reload(); } catch (caught) { setError((caught as Error).message); } }} />
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
