import { useEffect, useState, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmButton, ErrorAlert } from "@/components/common";
import { api, useApi, type Definition, type DiscordGuildChannel, type ManagedDiscordBinding, type ManagedDiscordConfig, type ManagedDiscordGuild } from "@/lib/api";
import { DefinitionDialog } from "./definitions";

const ids = (text: string) => text.split(/[\s,]+/).filter(Boolean);
const guildPath = (guildId: string) => `/console/discord/bindings/${encodeURIComponent(guildId)}`;

/** Shared bot management stays separate from the existing customer-token channel editor. */
export function ManagedDiscord({ onChanged, config, open, onOpenChange }: {
  onChanged: () => void; config: ManagedDiscordConfig; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const bindings = useApi<{ bindings: ManagedDiscordBinding[] }>(config.enabled ? "/console/discord/bindings" : undefined);
  const [editing, setEditing] = useState<ManagedDiscordBinding>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const setupGuild = new URLSearchParams(location.search).get("discord_setup");
  const activeBinding = editing ?? (open ? bindings.data?.bindings.find(binding => binding.guildId === setupGuild) : undefined);
  const changed = () => { void bindings.reload(); onChanged(); };
  async function state(binding: ManagedDiscordBinding, value: ManagedDiscordBinding["state"]) {
    setBusy(binding.guildId); setError(undefined);
    try { await api(guildPath(binding.guildId), { method: "PATCH", body: { state: value } }); changed(); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(undefined); }
  }
  if (!config.enabled) return null;
  return <>
    <ErrorAlert error={bindings.error ?? error} />
    {!!bindings.data?.bindings.length && <section className="mt-6 border bg-card p-4 space-y-4" aria-label="Camel Discord servers">
      <div><h2 className="font-semibold">Camel Discord servers</h2><p className="text-muted-foreground text-sm">Our shared bot, configured separately for each server.</p></div>
      {bindings.data.bindings.map(binding => <div key={binding.guildId} className="flex flex-wrap items-start justify-between gap-3 border-t pt-4">
        <div className="space-y-1">
          <p className="font-medium">{binding.guildName} <Badge variant="outline">{binding.state}</Badge> <Badge variant="outline">{binding.installationState}</Badge></p>
          <p className="text-muted-foreground text-xs">{binding.allowedChannelIds.length} allowed channel{binding.allowedChannelIds.length === 1 ? "" : "s"}{binding.channel && <> · {binding.channel.access.public ? "All server members" : `${binding.channel.access.allow.length} allowed members`}</>}</p>
          {!binding.channel && <p className="text-sm">Server setup is incomplete. Contact the runtime operator to recover it.</p>}
          {binding.installationState !== "present" && <p className="text-sm">{binding.installationState === "removed" ? "The bot was removed. Invite it again, then explicitly reactivate the server." : "Discord reports this server unavailable. Delivery is stopped until it returns."}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" disabled={!binding.channel} onClick={() => setEditing(binding)}>Configure</Button>
          {binding.channel && binding.state !== "disconnected" && <Button size="xs" variant="outline" disabled={busy === binding.guildId || (binding.state === "paused" && binding.installationState !== "present")} onClick={() => void state(binding, binding.state === "active" ? "paused" : "active")}>{binding.state === "active" ? "Pause" : "Resume"}</Button>}
          {binding.channel && binding.state !== "disconnected" && <ConfirmButton size="xs" label="Disconnect" title={`Disconnect Camel from ${binding.guildName}?`} description="Camel stops answering in this server. Conversation history is retained, and the bot stays installed in Discord. You can reactivate it from Configure." confirm="Disconnect" onConfirm={() => state(binding, "disconnected")} />}
        </div>
      </div>)}
    </section>}
    {(open || editing) && <ManagedDiscordDialog key={activeBinding?.guildId ?? "new"} config={config} binding={activeBinding} onClose={() => { onOpenChange(false); setEditing(undefined); }} onSaved={changed} />}
  </>;
}

export function ManagedDiscordDialog({ config, binding, onClose, onSaved }: {
  config: ManagedDiscordConfig; binding?: ManagedDiscordBinding; onClose: () => void; onSaved: () => void;
}) {
  const requested = new URLSearchParams(location.search).get("discord_setup") ?? "";
  const [guildId, setGuildId] = useState(binding?.guildId ?? (/^\d{17,20}$/.test(requested) ? requested : ""));
  const guilds = useApi<{ linked: boolean; guilds: ManagedDiscordGuild[] }>("/console/discord/guilds");
  const definitions = useApi<Definition[]>("/v1/definitions");
  const channels = useApi<{ channels: DiscordGuildChannel[] }>(guildId && guilds.data?.linked ? `/console/discord/guilds/${encodeURIComponent(guildId)}/channels` : undefined);
  const [definition, setDefinition] = useState(binding?.channel?.definition ?? "");
  const [definitionEditor, setDefinitionEditor] = useState<Definition | "new">();
  const [allowedChannels, setAllowedChannels] = useState(binding?.allowedChannelIds ?? []);
  const [publicAccess, setPublicAccess] = useState(binding?.channel?.access.public ?? false);
  const [allow, setAllow] = useState(binding?.channel?.access.allow.join(", ") ?? "");
  const [perMinute, setPerMinute] = useState(binding?.channel?.limits.perSenderPerMinute ?? 10);
  const [perDay, setPerDay] = useState(binding?.channel?.limits.turnsPerDay ?? 100);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<ManagedDiscordBinding>();
  const [error, setError] = useState(new URLSearchParams(location.search).get("discord_error") ?? "");
  const selectedGuild = guilds.data?.guilds.find(guild => guild.id === guildId);
  const installed = selectedGuild?.installed ?? (binding?.installationState === "present");
  useEffect(() => {
    if (definition || !definitions.data?.length) return;
    setDefinition(definitions.data[0].id);
  }, [definitions.data, definition]);
  async function authorize() {
    setBusy(true); setError("");
    try {
      const { url } = await api<{ url: string }>("/console/discord/authorize", { body: { ...(guildId ? { guildId } : {}) } });
      location.assign(url);
    } catch (caught) { setError((caught as Error).message); setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const body = { ...(!binding ? { guildId } : {}), definition, allowedChannelIds: allowedChannels, access: { public: publicAccess, allow: ids(allow) }, limits: { perSenderPerMinute: perMinute, turnsPerDay: perDay }, ...(binding?.state === "disconnected" ? { state: "active" } : {}) };
      const result = await api<ManagedDiscordBinding>(binding ? guildPath(binding.guildId) : "/console/discord/bindings", { method: binding ? "PATCH" : "POST", body });
      setSaved(result); onSaved();
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  const ready = guilds.data?.linked && selectedGuild && (binding || !selectedGuild.bindingState) && installed && definition && allowedChannels.length > 0 && (publicAccess || ids(allow).length > 0) && Number.isInteger(perMinute) && perMinute >= 1 && perMinute <= 100 && Number.isInteger(perDay) && perDay >= 1 && perDay <= 10_000;
  const selectedDefinition = definitions.data?.find(entry => entry.id === definition);
  const inviteUrl = config.inviteUrl && `${config.inviteUrl}${config.inviteUrl.includes("?") ? "&" : "?"}guild_id=${encodeURIComponent(guildId)}&disable_guild_select=true`;
  return <>
    <Dialog open onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        {saved ? <>
          <DialogHeader><DialogTitle>{saved.guildName} configured</DialogTitle><DialogDescription>Configuration saved. Send a new mention in an allowed channel to test a reply.</DialogDescription></DialogHeader>
          <Input aria-label="Camel Discord test message" readOnly value={`<@${config.applicationId}> status`} onFocus={event => event.target.select()} />
          <p className="text-muted-foreground text-sm">Choose the bot with the App badge in Discord autocomplete. Saving configuration does not verify delivery.</p>
          {saved.state === "paused" && <p className="text-sm">This server remains paused. Resume it from the server list when ready.</p>}
          {saved.applied && <div className="border p-3 space-y-2 text-sm">
            <p>Existing conversations: {saved.applied.filter(result => result.status === "updated").length} updated · {saved.applied.filter(result => result.status === "queued").length} queued · {saved.applied.filter(result => result.status === "failed").length} failed.</p>
            {saved.applied.some(result => result.status === "queued") && <p className="text-muted-foreground text-xs">Queued agents take the configuration between turns.</p>}
            {saved.applied.filter(result => result.status === "failed").map(result => <p key={result.agent} className="text-destructive text-xs"><span className="font-mono">{result.agent}</span>: {result.error ?? "Configuration could not be applied"}</p>)}
          </div>}
          <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
        </> : <form onSubmit={save} className="space-y-4">
          <DialogHeader><DialogTitle>{binding ? `Configure ${binding.guildName}` : "Add Camel bot"}</DialogTitle><DialogDescription>Invite our bot and give it your server's prompt, model and tools. Each channel or thread has a shared conversation. Every turn requires a direct mention.</DialogDescription></DialogHeader>
          <ErrorAlert error={error || guilds.error} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" disabled={busy} onClick={() => void authorize()}>{busy && <Loader2 className="animate-spin" />}{guilds.data?.linked ? "Verify Discord access again" : "Connect Discord account"}</Button>
            {guilds.data?.linked && <Button type="button" variant="ghost" onClick={() => { void guilds.reload(); void channels.reload(); }}>Refresh servers</Button>}
          </div>
          {guilds.data?.linked && <>
            <div className="space-y-2"><Label htmlFor="managed-discord-server">Server you manage</Label>
              <select id="managed-discord-server" className="h-9 w-full border bg-background px-3 text-sm" value={guildId} disabled={!!binding} onChange={event => { setGuildId(event.target.value); setAllowedChannels([]); }}>
                <option value="">Choose a server</option>
                {guilds.data.guilds.map(guild => <option key={guild.id} value={guild.id} disabled={!!guild.bindingState && (!guild.owned || !binding)}>{guild.name}{guild.bindingState ? guild.owned ? " — configure from your server list" : " — connected to another account" : ""}</option>)}
              </select>
              {!guilds.data.guilds.length && <p className="text-sm">No eligible servers. Your Discord account needs ownership, Administrator or Manage Server permission.</p>}
            </div>
            {guildId && !installed && <div className="border p-3 space-y-2 text-sm"><p>Install Camel in this server, then refresh to verify the installation.</p>{inviteUrl && <a className="underline" href={inviteUrl} target="_blank" rel="noreferrer">Invite Camel to this server</a>}</div>}
            {guildId && installed && <>
              <div className="space-y-2"><Label htmlFor="managed-discord-definition">Prompt, model and tools</Label>
                <select id="managed-discord-definition" className="h-9 w-full border bg-background px-3 text-sm" value={definition} onChange={event => setDefinition(event.target.value)}><option value="">Choose a definition</option>{definitions.data?.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
                <ErrorAlert error={definitions.error} />
                <div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setDefinitionEditor("new")}><Plus />New prompt &amp; tools</Button><Button type="button" variant="outline" size="sm" disabled={!selectedDefinition} onClick={() => setDefinitionEditor(selectedDefinition)}>Edit selected definition</Button></div>
                {selectedDefinition?.model && <p className="text-muted-foreground text-xs">Model: {selectedDefinition.model}</p>}
                <p className="text-muted-foreground text-xs">A shared definition also affects other agents and integrations using it. Apply edits to existing agents in the definition editor.</p>
              </div>
              <fieldset className="border p-3 space-y-2"><legend className="px-1 text-sm font-medium">Allowed channels</legend>
                <ErrorAlert error={channels.error} />
                {channels.loading ? <p className="text-sm">Loading channels…</p> : channels.data?.channels.length ? channels.data.channels.map(channel => <label key={channel.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allowedChannels.includes(channel.id)} onChange={event => setAllowedChannels(current => event.target.checked ? [...current, channel.id] : current.filter(id => id !== channel.id))} />#{channel.name}</label>) : <p className="text-sm">No available text channels. Check the bot's View Channel and Send Messages permissions.</p>}
                <p className="text-muted-foreground text-xs">Choose at least one channel. Threads in selected channels use the same access policy.</p>
              </fieldset>
              <div className="space-y-2"><Label htmlFor="managed-discord-members">Allowed member IDs</Label><Input id="managed-discord-members" placeholder="123456789012345678, …" value={allow} disabled={publicAccess} onChange={event => setAllow(event.target.value)} />
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={publicAccess} onChange={event => setPublicAccess(event.target.checked)} />Allow every member in selected channels</label>
                <p className="text-muted-foreground text-xs">Allowed members can invoke these tools using your account's credentials. Conversations are shared with channel participants, and usage is billed to your Camel account.</p>
              </div>
              <div className="flex flex-wrap gap-4"><div className="space-y-2"><Label htmlFor="managed-discord-rate">Turns per member per minute</Label><Input id="managed-discord-rate" type="number" min={1} max={100} step={1} value={perMinute} onChange={event => setPerMinute(Number(event.target.value))} /></div><div className="space-y-2"><Label htmlFor="managed-discord-daily">Turns per server per day</Label><Input id="managed-discord-daily" type="number" min={1} max={10_000} step={1} value={perDay} onChange={event => setPerDay(Number(event.target.value))} /></div></div>
            </>}
          </>}
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !ready}>{busy && <Loader2 className="animate-spin" />}{binding?.state === "disconnected" ? "Save and reactivate" : binding ? "Save configuration" : "Save and activate"}</Button></DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
    {definitionEditor && <DefinitionDialog definition={definitionEditor === "new" ? undefined : definitionEditor} forChannel={definitionEditor !== "new"} onClose={() => setDefinitionEditor(undefined)} onSaved={savedDefinition => { if (savedDefinition) setDefinition(savedDefinition.id); void definitions.reload(); }} />}
  </>;
}
