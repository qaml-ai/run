import { useState, type FormEvent } from "react";
import { Loader2, MessageCircle, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmButton, CopyButton, EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatTime, useApi, type Channel, type Definition } from "@/lib/api";

const NONE = "__none__";

function CreateChannelDialog({
  definitions,
  onClose,
  onCreated,
}: {
  definitions: Definition[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<"http" | "slack" | "email">("http");
  const [name, setName] = useState("");
  const [definition, setDefinition] = useState(NONE);
  const [outboundUrl, setOutboundUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api<Channel>("/v2/channels", {
        method: "POST",
        body: {
          kind,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(definition !== NONE ? { definition } : {}),
          ...(outboundUrl.trim() ? { outboundUrl: outboundUrl.trim() } : {}),
          ...(secret.trim() ? { secret: secret.trim() } : {}),
        },
      });
      onCreated();
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New channel</DialogTitle>
            <DialogDescription>
              Inbound messages posted to <code className="font-mono">/v2/channels/:id/inbound</code> automatically route into thread-keyed durable agents.
            </DialogDescription>
          </DialogHeader>
          <ErrorAlert error={error} />
          <div className="flex flex-col gap-2">
            <Label>Kind</Label>
            <Select value={kind} onValueChange={value => setKind(value as "http" | "slack" | "email")}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="http">HTTP</SelectItem>
                <SelectItem value="slack">Slack</SelectItem>
                <SelectItem value="email">Email</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-name">Name</Label>
            <Input id="channel-name" placeholder="e.g. Support inbox" value={name} onChange={event => setName(event.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Definition (optional)</Label>
            <Select value={definition} onValueChange={setDefinition}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Runtime defaults</SelectItem>
                {definitions.map(def => (
                  <SelectItem key={def.slug} value={def.slug}>{def.slug}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-outbound">Outbound reply URL (optional)</Label>
            <Input
              id="channel-outbound"
              placeholder="https://…"
              className="font-mono text-xs"
              value={outboundUrl}
              onChange={event => setOutboundUrl(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-secret">HMAC signing secret (optional)</Label>
            <Input
              id="channel-secret"
              type="password"
              autoComplete="off"
              placeholder="Verifies X-CamelRun-Signature on inbound requests"
              value={secret}
              onChange={event => setSecret(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}Create channel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ChannelsPage() {
  const channelsRes = useApi<{ channels: Channel[] }>("/v2/channels");
  const defsRes = useApi<{ definitions: Definition[] }>("/v2/definitions");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const channels = channelsRes.data?.channels;

  return (
    <>
      <PageHeader
        title="Channels"
        docs="channels"
        description="Route Slack, email, and HTTP inbound traffic into thread-keyed durable agents."
        actions={<Button size="sm" onClick={() => setCreating(true)}><Plus />New channel</Button>}
      />
      <ErrorAlert error={channelsRes.error ?? error} />
      {!channels ? (
        <Skeleton className="h-32 w-full" />
      ) : channels.length === 0 ? (
        <EmptyState
          icon={<MessageCircle />}
          title="No channels"
          action={<Button size="sm" onClick={() => setCreating(true)}><Plus />New channel</Button>}
        >
          Create a channel to receive inbound messages at <code className="font-mono">/v2/channels/:id/inbound</code> and automatically reply via an agent.
        </EmptyState>
      ) : (
        <div className="bg-card border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Inbound URL</TableHead>
                <TableHead className="hidden md:table-cell">Definition</TableHead>
                <TableHead className="hidden lg:table-cell">Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {channels.map(channel => {
                const inboundUrl = `${location.origin}/v2/channels/${channel.id}/inbound`;
                return (
                  <TableRow key={channel.id}>
                    <TableCell>
                      <div className="font-medium">{channel.name}</div>
                      <Badge variant="outline" className="mt-1">{channel.kind}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <span className="max-w-xs truncate font-mono text-xs">{inboundUrl}</span>
                        <CopyButton value={inboundUrl} label="Copy inbound URL" />
                      </div>
                      {channel.outboundUrl && (
                        <div className="text-muted-foreground max-w-xs truncate font-mono text-[11px]">
                          Reply → {channel.outboundUrl}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs md:table-cell">
                      {channel.definition ?? <span className="text-muted-foreground">default</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden text-xs lg:table-cell">
                      {formatTime(channel.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <ConfirmButton
                        size="xs"
                        label="Delete"
                        title={`Delete “${channel.name}”?`}
                        description="Inbound requests to this channel will return 404. Existing agent conversations remain intact."
                        confirm="Delete channel"
                        onConfirm={async () => {
                          try {
                            await api(`/v2/channels/${encodeURIComponent(channel.id)}`, { method: "DELETE" });
                            await channelsRes.reload();
                          } catch (caught) {
                            setError((caught as Error).message);
                          }
                        }}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {creating && (
        <CreateChannelDialog
          definitions={defsRes.data?.definitions ?? []}
          onClose={() => setCreating(false)}
          onCreated={() => void channelsRes.reload()}
        />
      )}
    </>
  );
}
