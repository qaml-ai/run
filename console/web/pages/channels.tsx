import { useState, type FormEvent } from "react";
import { Loader2, MessageCircle, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmButton, EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatTime, useApi, type Channel } from "@/lib/api";

const senders = (value: string) => value.split(/[\s,]+/).map(entry => entry.trim()).filter(Boolean);

/** Create a channel, or edit one's prompt and access (credentials are write-only). */
function ChannelDialog({ channel, onClose, onSaved }: { channel?: Channel; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(channel?.name ?? "");
  const [botToken, setBotToken] = useState("");
  const [model, setModel] = useState(channel?.template.model ?? "");
  const [systemPrompt, setSystemPrompt] = useState(channel?.template.systemPrompt ?? "");
  const [allow, setAllow] = useState(channel?.access.allow.join(", ") ?? "");
  const [open, setOpen] = useState(channel?.access.public ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    // The template is replaced whole: keep what this form does not edit.
    const template = { ...channel?.template, model: model.trim() || undefined, systemPrompt: systemPrompt.trim() || undefined };
    const body = {
      ...(name.trim() ? { name: name.trim() } : {}), template, access: { public: open, allow: senders(allow) },
      ...(botToken.trim() ? { credentials: { botToken: botToken.trim() } } : {}),
    };
    try {
      if (channel) await api(`/v1/channels/${channel.id}`, { method: "PATCH", body });
      else await api("/v1/channels", { body: { type: "telegram", ...body } });
      onSaved(); onClose();
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent>
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{channel ? `Edit ${channel.name}` : "New Telegram channel"}</DialogTitle>
            <DialogDescription>Each Telegram chat gets its own agent. Create a bot with @BotFather and paste its token; the runtime registers the webhook.</DialogDescription>
          </DialogHeader>
          <ErrorAlert error={error} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-token">Bot token{channel && <span className="text-muted-foreground font-normal"> (leave empty to keep {channel.credentials.botToken})</span>}</Label>
            <Input id="channel-token" type="password" autoComplete="off" placeholder="123456789:AA…" value={botToken} onChange={event => setBotToken(event.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-name">Name</Label>
            <Input id="channel-name" placeholder="Defaults to the bot's username" value={name} onChange={event => setName(event.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-model">Model</Label>
            <Input id="channel-model" placeholder="Runtime default, or e.g. anthropic/claude-sonnet-5" value={model} onChange={event => setModel(event.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-prompt">System prompt</Label>
            <Textarea id="channel-prompt" rows={4} value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-allow">Allowed senders</Label>
            <Input id="channel-allow" placeholder="@username, 123456789" value={allow} onChange={event => setAllow(event.target.value)} disabled={open} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={open} onChange={event => setOpen(event.target.checked)} />
              Public: anyone can message this bot (rate limits still apply)
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || (!channel && !botToken.trim())}>{busy && <Loader2 className="animate-spin" />}{channel ? "Save" : "Create channel"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ChannelsPage() {
  const channels = useApi<Channel[]>("/v1/channels");
  const [editing, setEditing] = useState<Channel | "new">();
  const [error, setError] = useState<string>();
  return (
    <>
      <PageHeader title="Channels" description="Let people talk to agents from messaging apps. Each conversation gets its own agent, created from the channel's template."
        actions={<Button size="sm" onClick={() => setEditing("new")}><Plus />New channel</Button>} />
      <ErrorAlert error={channels.error ?? error} />
      {!channels.data ? <Skeleton className="h-32 w-full" /> : channels.data.length === 0 ? (
        <EmptyState icon={<MessageCircle />} title="No channels">Connect a Telegram bot to talk to your agents from Telegram.</EmptyState>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Bot</TableHead><TableHead>Access</TableHead><TableHead className="hidden lg:table-cell">Created</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {channels.data.map(channel => (
                <TableRow key={channel.id}>
                  <TableCell className="font-medium">{channel.name}<div className="text-muted-foreground text-xs">{channel.type}</div></TableCell>
                  <TableCell className="font-mono text-xs">{channel.account.username ? `@${channel.account.username}` : channel.account.id}</TableCell>
                  <TableCell>{channel.access.public ? <Badge>Public</Badge> : <Badge variant="outline">{channel.access.allow.length} allowed</Badge>}</TableCell>
                  <TableCell className="text-muted-foreground hidden text-xs lg:table-cell">{formatTime(channel.createdAt)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button size="xs" variant="outline" className="mr-2" onClick={() => setEditing(channel)}>Edit</Button>
                    <ConfirmButton size="xs" label="Delete" title={`Delete “${channel.name}”?`} description="The bot's webhook is removed and it stops answering. Its conversations' agents are kept until they expire." confirm="Delete channel"
                      onConfirm={async () => { try { await api(`/v1/channels/${channel.id}`, { method: "DELETE" }); await channels.reload(); } catch (caught) { setError((caught as Error).message); } }} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {editing && <ChannelDialog channel={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={() => void channels.reload()} />}
    </>
  );
}
