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
import { ConfirmButton, EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatTime, useApi, type Channel, type Definition } from "@/lib/api";
import { DefinitionDialog } from "./definitions";
import { Link } from "@/lib/router";

const senders = (value: string) => value.split(/[\s,]+/).map(entry => entry.trim()).filter(Boolean);

type ChannelType = "telegram" | "slack" | "discord";
/** What each service needs, and how to get it. */
const TYPES: Record<ChannelType, { label: string; help: string; fields: { key: string; label: string; placeholder: string }[]; senders: string }> = {
  telegram: {
    label: "Telegram",
    help: "Each Telegram chat gets its own agent. Create a bot with @BotFather and paste its token; the runtime registers the webhook.",
    fields: [{ key: "botToken", label: "Bot token", placeholder: "123456789:AA…" }],
    senders: "@username, 123456789",
  },
  slack: {
    label: "Slack",
    help: "Each thread where someone @mentions the app, and each DM, gets its own agent. Create a Slack app with the bot scopes app_mentions:read, chat:write, im:history, channels:history and files:read, install it, and paste its bot token and signing secret. Then paste the webhook URL into the app's Event Subscriptions and subscribe to app_mention, message.im and message.channels.",
    fields: [{ key: "botToken", label: "Bot token", placeholder: "xoxb-…" }, { key: "signingSecret", label: "Signing secret", placeholder: "From Basic Information" }],
    senders: "Member IDs: U0123ABCD",
  },
  discord: {
    label: "Discord",
    help: "Each DM, channel or thread gets its own agent. In servers, select the bot user with the App badge when mentioning it. A role with the same name will not trigger a reply.",
    fields: [{ key: "botToken", label: "Bot token", placeholder: "From the Bot page" }],
    senders: "@username, 123456789012345678",
  },
};

/** Picking none gives a new channel a definition of its own with the runtime defaults. */
const OWN = "own";

/** Create a channel, or edit its definition and access (credentials are write-only). */
function ChannelDialog({ channel, onClose, onSaved }: { channel?: Channel; onClose: () => void; onSaved: (created?: Channel) => void }) {
  const [type, setType] = useState<ChannelType>((channel?.type as ChannelType) ?? "telegram");
  const [name, setName] = useState(channel?.name ?? "");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const definitions = useApi<Definition[]>("/v1/definitions");
  const [definition, setDefinition] = useState(channel?.definition ?? OWN);
  const [allow, setAllow] = useState(channel?.access.allow.join(", ") ?? "");
  const [open, setOpen] = useState(channel?.access.public ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const info = TYPES[type] ?? TYPES.telegram;
  // Credentials are replaced whole: all of a service's fields, or none to keep the stored ones.
  const entered = info.fields.map(field => credentials[field.key]?.trim() ?? "");
  const complete = entered.every(Boolean);
  const partial = entered.some(Boolean) && !complete;
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    const body = {
      ...(name.trim() ? { name: name.trim() } : {}), ...(definition !== OWN ? { definition } : {}), access: { public: open, allow: senders(allow) },
      ...(complete ? { credentials: Object.fromEntries(info.fields.map((field, index) => [field.key, entered[index]])) } : {}),
    };
    try {
      if (channel) { await api(`/v1/channels/${channel.id}`, { method: "PATCH", body }); onSaved(); }
      else onSaved(await api<Channel>("/v1/channels", { body: { type, ...body } }));
      onClose();
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{channel ? `Edit ${channel.name}` : `New ${info.label} channel`}</DialogTitle>
            <DialogDescription>{info.help}</DialogDescription>
          </DialogHeader>
          <ErrorAlert error={error} />
          {!channel && (
            <div className="flex flex-col gap-2">
              <Label>Service</Label>
              <Select value={type} onValueChange={value => { setType(value as ChannelType); setCredentials({}); }}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>{(Object.keys(TYPES) as ChannelType[]).map(key => <SelectItem key={key} value={key}>{TYPES[key].label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          {channel?.webhookUrl && channel.type === "slack" && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="channel-webhook">Webhook URL <span className="text-muted-foreground font-normal">(Event Subscriptions → Request URL)</span></Label>
              <Input id="channel-webhook" readOnly value={channel.webhookUrl} onFocus={event => event.target.select()} className="font-mono text-xs" />
            </div>
          )}
          {type === "discord" && !channel && <ol className="list-decimal pl-5 text-sm space-y-2">
            <li><a className="underline" href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Open the Discord Developer Portal</a> and create an application.</li>
            <li>On its Bot page, copy the bot token into the field below. It is stored encrypted; you do not need to paste it into a chat or terminal.</li>
            <li>Save here to validate the token, then use the invite link to add the bot to your server.</li>
          </ol>}
          {channel?.type === "discord" && <DiscordHelp channel={channel} />}
          {info.fields.map(field => (
            <div key={field.key} className="flex flex-col gap-2">
              <Label htmlFor={`channel-${field.key}`}>{field.label}{channel && <span className="text-muted-foreground font-normal"> (leave empty to keep {channel.credentials[field.key]})</span>}</Label>
              <Input id={`channel-${field.key}`} type="password" autoComplete="off" placeholder={field.placeholder} value={credentials[field.key] ?? ""}
                onChange={event => setCredentials(current => ({ ...current, [field.key]: event.target.value }))} />
            </div>
          ))}
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-name">Name</Label>
            <Input id="channel-name" placeholder="Defaults to the bot's username" value={name} onChange={event => setName(event.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Definition</Label>
            <Select value={definition} onValueChange={setDefinition}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Loading…" /></SelectTrigger>
              <SelectContent>
                {!channel?.definition && <SelectItem value={OWN}>Runtime defaults</SelectItem>}
                {definitions.data?.map(entry => <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">The model, prompt and tools each conversation's agent is made from. Manage them under <Link className="underline" to="definitions">Definitions</Link>; existing conversations keep the revision they started with unless you apply a new one there.</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-allow">Allowed senders</Label>
            <Input id="channel-allow" placeholder={info.senders} value={allow} onChange={event => setAllow(event.target.value)} disabled={open} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={open} onChange={event => setOpen(event.target.checked)} />
              Public: anyone can message this bot (rate limits still apply)
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || partial || (!channel && !complete)}>{busy && <Loader2 className="animate-spin" />}{channel ? "Save" : "Create channel"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DiscordHelp({ channel }: { channel: Channel }) {
  return <div className="rounded border p-3 text-sm space-y-2">
    <a className="underline" href={`https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(channel.account.id)}&scope=bot&permissions=68608`} target="_blank" rel="noreferrer">Invite {channel.account.username ?? "bot"} to your server</a>
    <p>For a test message, copy the text below into Discord and send it. It mentions the bot user directly.</p>
    <Input aria-label="Discord test message" readOnly value={`<@${channel.account.id}> status`} onFocus={event => event.target.select()} />
    <p className="text-muted-foreground text-xs">When using autocomplete, select the bot with the App badge, not the similarly named role. DMs need no mention.</p>
  </div>;
}

export function ChannelsPage() {
  const channels = useApi<Channel[]>("/v1/channels");
  const definitions = useApi<Definition[]>("/v1/definitions");
  const [modelDefinition, setModelDefinition] = useState<Definition>();
  const [connected, setConnected] = useState<Channel>();
  const [editing, setEditing] = useState<Channel | "new">();
  const [error, setError] = useState<string>();
  return (
    <>
      <PageHeader title="Channels" description="Let people talk to agents from messaging apps. Each conversation gets its own agent, made from the channel's definition."
        actions={<Button size="sm" onClick={() => setEditing("new")}><Plus />New channel</Button>} />
      <ErrorAlert error={channels.error ?? error} />
      {!channels.data ? <Skeleton className="h-32 w-full" /> : channels.data.length === 0 ? (
        <EmptyState icon={<MessageCircle />} title="No channels">Connect a Telegram, Slack or Discord bot to talk to your agents from there.</EmptyState>
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
                    <Button size="xs" variant="outline" className="mr-2" disabled={!definitions.data?.some(d => d.id === channel.definition)} onClick={() => setModelDefinition(definitions.data?.find(d => d.id === channel.definition))}>Model &amp; prompt</Button>
                    <Button size="xs" variant="outline" className="mr-2" onClick={() => setEditing(channel)}>Edit</Button>
                    <ConfirmButton size="xs" label="Delete" title={`Delete “${channel.name}”?`} description="The bot stops answering (a Telegram bot's webhook is removed). Its conversations' agents are kept until they expire." confirm="Delete channel"
                      onConfirm={async () => { try { await api(`/v1/channels/${channel.id}`, { method: "DELETE" }); await channels.reload(); } catch (caught) { setError((caught as Error).message); } }} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {modelDefinition && <DefinitionDialog definition={modelDefinition} forChannel onClose={() => setModelDefinition(undefined)} onSaved={() => void definitions.reload()} />}
      {connected && <Dialog open onOpenChange={value => { if (!value) setConnected(undefined); }}><DialogContent>
        <DialogHeader><DialogTitle>{connected.name} connected</DialogTitle><DialogDescription>Token validated and stored. Invite the bot, then send a test message.</DialogDescription></DialogHeader>
        <DiscordHelp channel={connected} />
        <DialogFooter><Button onClick={() => setConnected(undefined)}>Done</Button></DialogFooter>
      </DialogContent></Dialog>}
      {editing && <ChannelDialog channel={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={created => {
        void channels.reload();
        void definitions.reload();
        if (created?.type === "discord") setConnected(created);
        // A Slack app needs the webhook URL pasted into its settings: show it straight away.
        if (created?.type === "slack") setTimeout(() => setEditing(created));
      }} />}
    </>
  );
}
