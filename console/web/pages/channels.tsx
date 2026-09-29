import { useState, type FormEvent } from "react";
import { Loader2, MessageCircle, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmButton, EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatTime, useApi, type Channel, type Definition } from "@/lib/api";
import { DefinitionDialog } from "./definitions";
import { Link } from "@/lib/router";

const senders = (value: string) => value.split(/[\s,]+/).map(entry => entry.trim()).filter(Boolean);

type ChannelType = "telegram" | "slack" | "discord" | "github" | "webhook" | "email";
type Field = { key: string; label: string; placeholder: string; multiline?: boolean; optional?: boolean };
/** What each service needs, and how to get it. `webhook` says where to paste the channel's webhook URL, for services that cannot be told it. */
const TYPES: Record<ChannelType, { label: string; help: string; fields: Field[]; senders: string; webhook?: string }> = {
  telegram: {
    label: "Telegram",
    help: "Each Telegram chat gets its own agent. Create a bot with @BotFather and paste its token; the runtime registers the webhook.",
    fields: [{ key: "botToken", label: "Bot token", placeholder: "123456789:AA…" }],
    senders: "@username, 123456789",
  },
  slack: {
    label: "Slack",
    help: "Each thread where someone @mentions the app, and each DM, gets its own agent. Create a Slack app with the bot scopes app_mentions:read, chat:write, im:history, channels:history, files:read and files:write, install it, and paste its bot token and signing secret. Then paste the webhook URL into the app's Event Subscriptions and subscribe to app_mention, message.im and message.channels.",
    fields: [{ key: "botToken", label: "Bot token", placeholder: "xoxb-…" }, { key: "signingSecret", label: "Signing secret", placeholder: "From Basic Information" }],
    senders: "Member IDs: U0123ABCD",
    webhook: "Event Subscriptions → Request URL",
  },
  discord: {
    label: "Discord",
    help: "Each DM, and each channel or thread where someone @mentions the bot, gets its own agent.",
    fields: [{ key: "botToken", label: "Bot token", placeholder: "From the Bot page" }],
    senders: "@username, 123456789012345678",
  },
  github: {
    label: "GitHub",
    help: "Each pull request (and issue, if you choose) gets its own agent, which answers with a comment. Create a GitHub App with the permissions Pull requests (read and write), Issues (read and write), Contents (read) and Metadata (read), subscribe it to Pull request, Issue comment and Pull request review comment events, generate a private key, and install it on your repositories.",
    fields: [
      { key: "appId", label: "App ID", placeholder: "From the app's General settings" },
      { key: "privateKey", label: "Private key", placeholder: "-----BEGIN RSA PRIVATE KEY-----\n…", multiline: true },
      { key: "webhookSecret", label: "Webhook secret", placeholder: "The secret you set on the app" },
    ],
    senders: "GitHub usernames: @octocat",
    webhook: "the app's General settings → Webhook URL",
  },
  webhook: {
    label: "Webhook",
    help: "Any service that sends webhooks (Sentry, Linear, Stripe, your own) starts agents. Each delivery must be signed with the secret; a key template decides which agent it goes to, and the payload is attached as payload.json.",
    fields: [
      { key: "secret", label: "Signing secret", placeholder: "The sender's signing secret (whsec_… for Standard Webhooks)" },
      { key: "replyUrl", label: "Reply URL", placeholder: "Optional: where each turn's reply is POSTed, signed", optional: true },
    ],
    senders: "",
    webhook: "the sending service's webhook settings",
  },
  email: {
    label: "Email",
    help: "Each email thread sent to the channel's address gets its own agent, which replies in the thread. Only senders whose mail passes SPF or DKIM for their own domain are let in. Available when the runtime has an email domain.",
    fields: [],
    senders: "ada@example.com, @example.com",
  },
};

const GITHUB_EVENTS: { value: string; label: string }[] = [
  { value: "pull_request.opened", label: "Pull request opened" },
  { value: "pull_request.reopened", label: "Pull request reopened" },
  { value: "pull_request.ready_for_review", label: "Pull request ready for review" },
  { value: "pull_request.synchronize", label: "New commits pushed" },
  { value: "issue_comment", label: "Comment that @mentions the app" },
  { value: "pull_request_review_comment", label: "Review comment that @mentions the app" },
  { value: "issues.opened", label: "Issue opened" },
];
const GITHUB_DEFAULTS = { events: GITHUB_EVENTS.map(event => event.value).filter(event => event !== "issues.opened"), repos: [] as string[], ignoreDrafts: true, reply: "comment", authors: "allowlist", debounceSeconds: 30 };
type Settings = Record<string, any>;

/** Settings the console edits, with the defaults a new channel of the type starts from. */
function initialSettings(type: ChannelType, stored?: Settings): Settings {
  if (type === "github") return { ...GITHUB_DEFAULTS, ...stored };
  if (type === "webhook") return { signature: { type: "standard" }, ...stored, filter: stored?.filter ? JSON.stringify(stored.filter, null, 2) : "" };
  if (type === "email") return { address: stored?.address ?? "", fromName: stored?.fromName ?? "" };
  return {};
}

/** The settings to send: every field, an emptied optional one as null so the stored value is cleared. */
function settingsBody(type: ChannelType, settings: Settings): Settings | undefined {
  if (type === "github") return { ...settings, repos: senders(settings.repos.join ? settings.repos.join(" ") : settings.repos) };
  if (type === "email") return { ...(settings.address.trim() ? { address: settings.address.trim() } : {}), ...(settings.fromName.trim() ? { fromName: settings.fromName.trim() } : {}) };
  if (type !== "webhook") return undefined;
  const optional = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
  let filter: unknown = null;
  if (settings.filter?.trim()) {
    try { filter = JSON.parse(settings.filter); } catch { throw new Error("Filter: not valid JSON"); }
  }
  const signature = settings.signature.type === "standard" ? { type: "standard" } : settings.signature.type === "token"
    ? { type: "token", header: settings.signature.header ?? "" }
    : { type: "hmac-sha256", header: settings.signature.header ?? "", ...(settings.signature.prefix ? { prefix: settings.signature.prefix } : {}), ...(settings.signature.encoding ? { encoding: settings.signature.encoding } : {}) };
  return { signature, key: optional(settings.key), prompt: optional(settings.prompt), sender: optional(settings.sender), filter, idPath: optional(settings.idPath), idHeader: optional(settings.idHeader) };
}

function GitHubSettings({ settings, set }: { settings: Settings; set: (next: Settings) => void }) {
  const events: string[] = settings.events;
  return <div className="flex flex-col gap-4 rounded border p-3">
    <div className="flex flex-col gap-2">
      <Label>Start a turn on</Label>
      {GITHUB_EVENTS.map(event => <label key={event.value} className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={events.includes(event.value)} onChange={change => set({ ...settings, events: change.target.checked ? [...events, event.value] : events.filter(value => value !== event.value) })} />
        {event.label}
      </label>)}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={settings.ignoreDrafts} onChange={change => set({ ...settings, ignoreDrafts: change.target.checked })} />
        Skip draft pull requests
      </label>
    </div>
    <div className="flex flex-col gap-2">
      <Label htmlFor="github-repos">Repositories</Label>
      <Input id="github-repos" placeholder="All the app is installed on; or owner/repo, owner/*" value={Array.isArray(settings.repos) ? settings.repos.join(", ") : settings.repos}
        onChange={change => set({ ...settings, repos: change.target.value })} />
    </div>
    <div className="flex flex-wrap gap-4">
      <div className="flex flex-col gap-2">
        <Label>Reply</Label>
        <Select value={settings.reply} onValueChange={reply => set({ ...settings, reply })}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="comment">Comment with the answer</SelectItem>
            <SelectItem value="none">Nothing: act through tools</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label>Who can start a turn</Label>
        <Select value={settings.authors} onValueChange={authors => set({ ...settings, authors })}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="allowlist">Allowed senders only</SelectItem>
            <SelectItem value="members">Also owners, members, collaborators</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="github-debounce">Wait after a push (s)</Label>
        <Input id="github-debounce" type="number" min={0} max={600} className="w-28" value={settings.debounceSeconds}
          onChange={change => set({ ...settings, debounceSeconds: Number(change.target.value) })} />
      </div>
    </div>
    <p className="text-muted-foreground text-xs">Pull request text and comments are written by whoever opened them: keep write tools behind approval for repositories that take outside contributions.</p>
  </div>;
}

function EmailSettings({ settings, set }: { settings: Settings; set: (next: Settings) => void }) {
  return <div className="flex flex-wrap gap-4 rounded border p-3">
    <div className="flex flex-col gap-2">
      <Label htmlFor="email-address">Address</Label>
      <Input id="email-address" className="w-56 font-mono text-xs" placeholder="support (default: the channel id)" value={settings.address} onChange={change => set({ ...settings, address: change.target.value })} />
    </div>
    <div className="flex flex-col gap-2">
      <Label htmlFor="email-from">Sender name</Label>
      <Input id="email-from" className="w-56" placeholder="Support" value={settings.fromName} onChange={change => set({ ...settings, fromName: change.target.value })} />
    </div>
  </div>;
}

function WebhookSettings({ settings, set }: { settings: Settings; set: (next: Settings) => void }) {
  const signature = settings.signature ?? { type: "standard" };
  const field = (key: string, label: string, placeholder: string, multiline = false) => <div className="flex flex-col gap-2">
    <Label htmlFor={`webhook-${key}`}>{label}</Label>
    {multiline
      ? <Textarea id={`webhook-${key}`} className="font-mono text-xs" rows={4} placeholder={placeholder} value={settings[key] ?? ""} onChange={change => set({ ...settings, [key]: change.target.value })} />
      : <Input id={`webhook-${key}`} className="font-mono text-xs" placeholder={placeholder} value={settings[key] ?? ""} onChange={change => set({ ...settings, [key]: change.target.value })} />}
  </div>;
  return <div className="flex flex-col gap-4 rounded border p-3">
    <div className="flex flex-wrap gap-4">
      <div className="flex flex-col gap-2">
        <Label>Signature</Label>
        <Select value={signature.type} onValueChange={type => set({ ...settings, signature: { ...signature, type } })}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="standard">Standard Webhooks</SelectItem>
            <SelectItem value="hmac-sha256">HMAC-SHA256 of the body</SelectItem>
            <SelectItem value="token">Token in a header</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {signature.type !== "standard" && <div className="flex flex-col gap-2">
        <Label htmlFor="webhook-header">Header</Label>
        <Input id="webhook-header" className="w-48 font-mono text-xs" placeholder={signature.type === "token" ? "x-webhook-token" : "x-hub-signature-256"} value={signature.header ?? ""}
          onChange={change => set({ ...settings, signature: { ...signature, header: change.target.value } })} />
      </div>}
      {signature.type === "hmac-sha256" && <>
        <div className="flex flex-col gap-2">
          <Label htmlFor="webhook-prefix">Prefix</Label>
          <Input id="webhook-prefix" className="w-28 font-mono text-xs" placeholder="sha256=" value={signature.prefix ?? ""}
            onChange={change => set({ ...settings, signature: { ...signature, prefix: change.target.value } })} />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Encoding</Label>
          <Select value={signature.encoding ?? "hex"} onValueChange={encoding => set({ ...settings, signature: { ...signature, encoding } })}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="hex">hex</SelectItem><SelectItem value="base64">base64</SelectItem></SelectContent>
          </Select>
        </div>
      </>}
    </div>
    {field("key", "Agent key", "One agent for every delivery; or e.g. sentry-{{data.issue.id}}")}
    {field("prompt", "Prompt", "The payload as JSON; or e.g. Triage this Sentry issue: {{data.issue.title}}", true)}
    {field("sender", "Sender", "webhook; or e.g. {{actor.email}}")}
    {field("filter", "Filter (JSON)", '[{"path": "action", "in": ["created"]}]', true)}
    <div className="flex flex-wrap gap-4">
      {field("idPath", "Delivery id path", "Default: the id header")}
      {field("idHeader", "Delivery id header", "webhook-id, x-request-id, …")}
    </div>
    <p className="text-muted-foreground text-xs">Templates take {"{{dotted.path}}"} into the payload, and {"{{headers.name}}"} for a request header.</p>
  </div>;
}

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
  const [settings, setSettings] = useState<Settings>(() => initialSettings((channel?.type as ChannelType) ?? "telegram", channel?.settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const info = TYPES[type] ?? TYPES.telegram;
  // Credentials are replaced whole: all of a service's fields, or none to keep the stored ones.
  const entered = info.fields.map(field => credentials[field.key]?.trim() ?? "");
  const complete = info.fields.every((field, index) => field.optional || entered[index]);
  const partial = entered.some(Boolean) && !complete;
  // A new channel needs its credentials, unless its type takes none that are required.
  const ready = complete && (entered.some(Boolean) || info.fields.every(field => field.optional));
  // A webhook's signature is its gate: who may send is not a question, so its access is left to the runtime's default.
  const hasAccess = type !== "webhook";
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try {
      const typeSettings = settingsBody(type, settings);
      const body = {
        ...(name.trim() ? { name: name.trim() } : {}), ...(definition !== OWN ? { definition } : {}), ...(hasAccess ? { access: { public: open, allow: senders(allow) } } : {}),
        ...(complete && entered.some(Boolean) ? { credentials: Object.fromEntries(info.fields.flatMap((field, index) => entered[index] ? [[field.key, entered[index]]] : [])) } : {}),
        ...(typeSettings ? { settings: typeSettings } : {}),
      };
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
              <Select value={type} onValueChange={value => { setType(value as ChannelType); setCredentials({}); setSettings(initialSettings(value as ChannelType)); }}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>{(Object.keys(TYPES) as ChannelType[]).map(key => <SelectItem key={key} value={key}>{TYPES[key].label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          {channel?.webhookUrl && info.webhook && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="channel-webhook">Webhook URL</Label>
              <Input id="channel-webhook" readOnly value={channel.webhookUrl} onFocus={event => event.target.select()} className="font-mono text-xs" />
              <p className="text-muted-foreground text-xs">Paste it into {info.webhook}.</p>
            </div>
          )}
          {type === "discord" && !channel && <ol className="list-decimal pl-5 text-sm space-y-2">
            <li>In the <a className="underline" href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Discord Developer Portal</a>, create an application.</li>
            <li>On its Bot page, copy the bot token and paste it below.</li>
            <li>Save: the token is checked, and you get the bot's invite link.</li>
          </ol>}
          {channel?.type === "discord" && <DiscordHelp channel={channel} />}
          {info.fields.map(field => (
            <div key={field.key} className="flex flex-col gap-2">
              <Label htmlFor={`channel-${field.key}`}>{field.label}{channel && channel.credentials[field.key] && <span className="text-muted-foreground font-normal"> (leave empty to keep {channel.credentials[field.key]})</span>}</Label>
              {field.multiline
                ? <Textarea id={`channel-${field.key}`} autoComplete="off" spellCheck={false} rows={4} className="font-mono text-xs" placeholder={field.placeholder} value={credentials[field.key] ?? ""}
                  onChange={event => setCredentials(current => ({ ...current, [field.key]: event.target.value }))} />
                : <Input id={`channel-${field.key}`} type="password" autoComplete="off" placeholder={field.placeholder} value={credentials[field.key] ?? ""}
                  onChange={event => setCredentials(current => ({ ...current, [field.key]: event.target.value }))} />}
            </div>
          ))}
          {channel && info.fields.length > 1 && <p className="text-muted-foreground text-xs">Credentials are replaced together: enter all of them to change any.</p>}
          {type === "github" && <GitHubSettings settings={settings} set={setSettings} />}
          {type === "webhook" && <WebhookSettings settings={settings} set={setSettings} />}
          {type === "email" && <EmailSettings settings={settings} set={setSettings} />}
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
          {hasAccess && <div className="flex flex-col gap-2">
            <Label htmlFor="channel-allow">Allowed senders</Label>
            <Input id="channel-allow" placeholder={info.senders} value={allow} onChange={event => setAllow(event.target.value)} disabled={open} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={open} onChange={event => setOpen(event.target.checked)} />
              Public: anyone can message this bot (rate limits still apply)
            </label>
          </div>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || partial || (!channel && !ready)}>{busy && <Loader2 className="animate-spin" />}{channel ? "Save" : "Create channel"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** View Channel, Send Messages, Attach Files, Read Message History and Send Messages in Threads. */
const DISCORD_PERMISSIONS = (1n << 10n | 1n << 11n | 1n << 15n | 1n << 16n | 1n << 38n).toString();

function DiscordHelp({ channel }: { channel: Channel }) {
  return <div className="border p-3 text-sm space-y-2">
    <a className="underline" href={`https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(channel.account.id)}&scope=bot&permissions=${DISCORD_PERMISSIONS}`} target="_blank" rel="noreferrer">Invite {channel.account.username ?? "bot"} to your server</a>
    <p>To test it, send this in a channel the bot can see. In autocomplete, pick the bot with the App badge: mentioning a role of the same name does not reach it.</p>
    <Input aria-label="Discord test message" readOnly value={`<@${channel.account.id}> status`} onFocus={event => event.target.select()} />
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
      <PageHeader title="Channels" description="Let people talk to agents from messaging apps, and start agents from GitHub and webhooks. Each conversation (a chat, a pull request, a key) gets its own agent, made from the channel's definition."
        actions={<Button size="sm" onClick={() => setEditing("new")}><Plus />New channel</Button>} />
      <ErrorAlert error={channels.error ?? error} />
      {!channels.data ? <Skeleton className="h-32 w-full" /> : channels.data.length === 0 ? (
        <EmptyState icon={<MessageCircle />} title="No channels">Connect a Telegram, Slack or Discord bot to talk to your agents from there, a GitHub App to have them answer pull requests, or any service's webhooks.</EmptyState>
      ) : (
        <div className="bg-card border">
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Bot or address</TableHead><TableHead>Access</TableHead><TableHead className="hidden lg:table-cell">Created</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {channels.data.map(channel => (
                <TableRow key={channel.id}>
                  <TableCell className="font-medium">{channel.name}<div className="text-muted-foreground text-xs">{channel.type}</div></TableCell>
                  <TableCell className="font-mono text-xs">{channel.type === "email" ? channel.settings?.address : channel.account.username ? `@${channel.account.username}` : channel.account.id ?? "—"}</TableCell>
                  <TableCell>{channel.access.public ? <Badge>Public</Badge> : <Badge variant="outline">{channel.access.allow.length} allowed</Badge>}</TableCell>
                  <TableCell className="text-muted-foreground hidden text-xs lg:table-cell">{formatTime(channel.createdAt)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button size="xs" variant="outline" className="mr-2" disabled={!definitions.data?.some(d => d.id === channel.definition)} onClick={() => setModelDefinition(definitions.data?.find(d => d.id === channel.definition))}>Model &amp; prompt</Button>
                    <Button size="xs" variant="outline" className="mr-2" onClick={() => setEditing(channel)}>Edit</Button>
                    <ConfirmButton size="xs" label="Delete" title={`Delete “${channel.name}”?`} description="The channel stops answering (a Telegram bot's webhook is removed; other webhooks get 404). Its conversations' agents are kept until they expire." confirm="Delete channel"
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
      {editing && <ChannelDialog key={editing === "new" ? "new" : editing.id} channel={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={created => {
        void channels.reload();
        void definitions.reload();
        if (created?.type === "discord") setConnected(created);
        // Slack, GitHub and webhook senders need the webhook URL pasted into their settings: show it straight away.
        if (created && created.webhookUrl && TYPES[created.type as ChannelType]?.webhook) setTimeout(() => setEditing(created));
        // An email channel's address is where people write to: show it straight away.
        if (created?.type === "email") setTimeout(() => setEditing(created));
      }} />}
    </>
  );
}
