import { useEffect, useState, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmButton, ErrorAlert, WarningsAlert } from "@/components/common";
import { api, useApi, type Definition, type DiscordGuildChannel, type ManagedDiscordBinding, type ManagedDiscordConfig } from "@/lib/api";
import { DefinitionDialog } from "./definitions";

const ids = (text: string) => text.split(/[\s,]+/).filter(Boolean);
const guildPath = (guildId: string) => `/console/discord/bindings/${encodeURIComponent(guildId)}`;

/** Servers Camel was added to from this account. Adding happens in Discord (one authorization); setup continues here. */
export function ManagedDiscord({ onChanged, config }: { onChanged: () => void; config: ManagedDiscordConfig }) {
  const bindings = useApi<{ bindings: ManagedDiscordBinding[] }>(config.enabled ? "/console/discord/bindings" : undefined);
  const query = new URLSearchParams(location.search);
  const [opened, setOpened] = useState(query.get("discord_server") ?? undefined);
  const [editing, setEditing] = useState<ManagedDiscordBinding>();
  const [error, setError] = useState(query.get("discord_error") ?? undefined);
  const [busy, setBusy] = useState<string>();
  // Back from Discord: open the server just added.
  const active = editing ?? bindings.data?.bindings.find(binding => binding.guildId === opened);
  const changed = () => { void bindings.reload(); onChanged(); };
  async function state(binding: ManagedDiscordBinding, value: ManagedDiscordBinding["state"]) {
    setBusy(binding.guildId); setError(undefined);
    try { await api(guildPath(binding.guildId), { method: "PATCH", body: { state: value } }); changed(); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(undefined); }
  }
  if (!config.enabled) return null;
  const install = config.installPath ?? "/console/discord/install";
  return <>
    <ErrorAlert error={bindings.error ?? error} title="Camel Discord" />
    {!!bindings.data?.bindings.length && <section className="mt-6 border bg-card p-4 space-y-4" aria-label="Camel Discord servers">
      <div><h2 className="font-semibold">Camel Discord servers</h2><p className="text-muted-foreground text-sm">Our shared bot, configured separately for each server.</p></div>
      {bindings.data.bindings.map(binding => <div key={binding.guildId} className="flex flex-wrap items-start justify-between gap-3 border-t pt-4">
        <div className="space-y-1">
          <p className="font-medium">{binding.guildName || binding.guildId} <Badge variant="outline">{binding.channel ? binding.state : "needs setup"}</Badge> <Badge variant="outline">{binding.installationState}</Badge></p>
          <p className="text-muted-foreground text-xs">{binding.allowedChannelIds.length} allowed channel{binding.allowedChannelIds.length === 1 ? "" : "s"}{binding.channel && <> · {binding.channel.access.public ? "All server members" : `${binding.channel.access.allow.length} allowed members`}</>}</p>
          {binding.installationState === "removed" && <p className="text-sm">Camel was removed from this server. <a className="underline" href={`${install}?guild_id=${binding.guildId}`}>Add it again</a>, then resume it.</p>}
          {binding.installationState === "unavailable" && <p className="text-sm">Discord reports this server unavailable. Delivery is stopped until it returns.</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant={binding.channel ? "outline" : "default"} onClick={() => setEditing(binding)}>{binding.channel ? "Configure" : "Finish setup"}</Button>
          {binding.channel && binding.state !== "disconnected" && <Button size="xs" variant="outline" disabled={busy === binding.guildId || (binding.state === "paused" && binding.installationState !== "present")} onClick={() => void state(binding, binding.state === "active" ? "paused" : "active")}>{binding.state === "active" ? "Pause" : "Resume"}</Button>}
          {binding.state !== "disconnected" && <ConfirmButton size="xs" label="Disconnect" title={`Disconnect Camel from ${binding.guildName || "this server"}?`} description="Camel stops answering in this server. Conversation history is retained, and the bot stays in the server. You can reactivate it from Configure." confirm="Disconnect" onConfirm={() => state(binding, "disconnected")} />}
        </div>
      </div>)}
    </section>}
    {active && <ManagedDiscordDialog key={active.guildId} config={config} binding={active} onClose={() => { setOpened(undefined); setEditing(undefined); }} onSaved={changed} />}
  </>;
}

/**
 * What a server's first setup starts from. Get started's Discord path opens it to every member, with tighter limits,
 * `preselect`s one channel and closes on saving (unless the save has something to say) instead of confirming.
 */
export interface SetupDefaults { definition?: string; public?: boolean; perSenderPerMinute?: number; turnsPerDay?: number; preselect?: boolean }

/** The channel a first setup starts with: the server's system channel, else the first text channel, where Camel may post. */
export function preselected(channels: DiscordGuildChannel[]) {
  const usable = channels.filter(channel => channel.type === 0 && channel.canPost !== false);
  const system = usable.find(channel => channel.system);
  return system ? { channel: system, why: "the server's system channel" } : usable[0] && { channel: usable[0], why: "the first text channel Camel can post in" };
}

export function ManagedDiscordDialog({ config, binding, onClose, onSaved, defaults = {} }: {
  config: ManagedDiscordConfig; binding: ManagedDiscordBinding; onClose: () => void; onSaved: () => void; defaults?: SetupDefaults;
}) {
  const setup = !binding.channel;
  const definitions = useApi<Definition[]>("/v1/definitions");
  const channels = useApi<{ channels: DiscordGuildChannel[] }>(`/console/discord/guilds/${encodeURIComponent(binding.guildId)}/channels`);
  const [definition, setDefinition] = useState(binding.channel?.definition ?? defaults.definition ?? "");
  const [definitionEditor, setDefinitionEditor] = useState<Definition | "new">();
  const [allowedChannels, setAllowedChannels] = useState(binding.allowedChannelIds);
  const [publicAccess, setPublicAccess] = useState(binding.channel?.access.public ?? defaults.public ?? false);
  const [allow, setAllow] = useState(binding.channel?.access.allow.join(", ") ?? "");
  const [perMinute, setPerMinute] = useState(binding.channel?.limits.perSenderPerMinute ?? defaults.perSenderPerMinute ?? 5);
  const [perDay, setPerDay] = useState(binding.channel?.limits.turnsPerDay ?? defaults.turnsPerDay ?? 100);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<ManagedDiscordBinding>();
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState<ReturnType<typeof preselected>>();
  useEffect(() => {
    if (!defaults.preselect || !setup || allowedChannels.length || !channels.data) return;
    const pick = preselected(channels.data.channels);
    if (pick) { setAllowedChannels([pick.channel.id]); setChosen(pick); }
  }, [channels.data]);
  useEffect(() => {
    if (definition || !definitions.data?.length) return;
    setDefinition(definitions.data[0].id);
  }, [definitions.data, definition]);
  const maxPerDay = config.limits?.turnsPerDay ?? 10_000;
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const body = { definition, allowedChannelIds: allowedChannels, access: { public: publicAccess, allow: ids(allow) }, limits: { perSenderPerMinute: perMinute, turnsPerDay: perDay }, ...(binding.state === "disconnected" ? { state: "active" } : {}) };
      const result = await api<ManagedDiscordBinding>(guildPath(binding.guildId), { method: "PATCH", body }); onSaved();
      // From Get started, its next step (say hello) is the confirmation; a save with warnings still shows them.
      if (defaults.preselect && setup && !result.warnings?.length && result.state === "active") { onClose(); return; }
      setSaved(result);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  const ready = binding.installationState === "present" && definition && allowedChannels.length > 0 && (publicAccess || ids(allow).length > 0) && Number.isInteger(perMinute) && perMinute >= 1 && perMinute <= 100 && Number.isInteger(perDay) && perDay >= 1 && perDay <= maxPerDay;
  const selectedDefinition = definitions.data?.find(entry => entry.id === definition);
  const name = binding.guildName || "this server";
  return <>
    <Dialog open onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        {saved ? <>
          <DialogHeader><DialogTitle>{saved.guildName || name} configured</DialogTitle><DialogDescription>Configuration saved. Send a new mention in an allowed channel to test a reply.</DialogDescription></DialogHeader>
          <Input aria-label="Camel Discord test message" readOnly value={`<@${config.applicationId}> status`} onFocus={event => event.target.select()} />
          <p className="text-muted-foreground text-sm">Choose the bot with the App badge in Discord autocomplete. Saving configuration does not verify delivery.</p>
          <WarningsAlert warnings={saved.warnings} className="mb-0" />
          {saved.state === "paused" && <p className="text-sm">This server remains paused. Resume it from the server list when ready.</p>}
          {saved.applied && <div className="border p-3 space-y-2 text-sm">
            <p>Existing conversations: {saved.applied.filter(result => result.status === "updated").length} updated · {saved.applied.filter(result => result.status === "queued").length} queued · {saved.applied.filter(result => result.status === "failed").length} failed.</p>
            {saved.applied.some(result => result.status === "queued") && <p className="text-muted-foreground text-xs">Queued agents take the configuration between turns.</p>}
            {saved.applied.filter(result => result.status === "failed").map(result => <p key={result.agent} className="text-destructive text-xs"><span className="font-mono">{result.agent}</span>: {result.error ?? "Configuration could not be applied"}</p>)}
          </div>}
          <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
        </> : <form onSubmit={save} className="space-y-4">
          <DialogHeader><DialogTitle>{setup ? `Set up Camel in ${name}` : `Configure ${name}`}</DialogTitle><DialogDescription>Give Camel this server's prompt, model and tools. Each channel or thread has a shared conversation. Every turn requires a direct mention.</DialogDescription></DialogHeader>
          <ErrorAlert error={error || undefined} />
          {binding.installationState !== "present" && <p className="text-sm">Camel is not in this server right now; add it again before saving.</p>}
          <div className="space-y-2"><Label htmlFor="managed-discord-definition">Prompt, model and tools</Label>
            <select id="managed-discord-definition" className="h-9 w-full border bg-background px-3 text-sm" value={definition} onChange={event => setDefinition(event.target.value)}><option value="">Choose a definition</option>{definitions.data?.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
            <ErrorAlert error={definitions.error} />
            <div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setDefinitionEditor("new")}><Plus />New prompt &amp; tools</Button><Button type="button" variant="outline" size="sm" disabled={!selectedDefinition} onClick={() => setDefinitionEditor(selectedDefinition)}>Edit selected definition</Button></div>
            {selectedDefinition?.model && <p className="text-muted-foreground text-xs">Model: {selectedDefinition.model}</p>}
            <p className="text-muted-foreground text-xs">A shared definition also affects other agents and integrations using it. Servers cannot use the schedule builtin.</p>
          </div>
          <fieldset className="border p-3 space-y-2"><legend className="px-1 text-sm font-medium">Allowed channels</legend>
            <ErrorAlert error={channels.error} />
            {channels.loading ? <p className="text-sm">Loading channels…</p> : channels.data?.channels.length ? channels.data.channels.map(channel => <label key={channel.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allowedChannels.includes(channel.id)} onChange={event => setAllowedChannels(current => event.target.checked ? [...current, channel.id] : current.filter(id => id !== channel.id))} />#{channel.name}</label>) : <p className="text-sm">No available text channels. Check the bot's View Channel and Send Messages permissions.</p>}
            {chosen && allowedChannels.length === 1 && allowedChannels[0] === chosen.channel.id && <p className="text-xs">Camel will answer in <span className="font-medium">#{chosen.channel.name}</span>, {chosen.why}. Add or change channels here.</p>}
            <p className="text-muted-foreground text-xs">Choose at least one channel. Threads in selected channels use the same access policy.</p>
          </fieldset>
          <div className="space-y-2"><Label htmlFor="managed-discord-members">Allowed member IDs</Label><Input id="managed-discord-members" placeholder="123456789012345678, …" value={allow} disabled={publicAccess} onChange={event => setAllow(event.target.value)} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={publicAccess} onChange={event => setPublicAccess(event.target.checked)} />Allow every member in selected channels</label>
            <p className="text-muted-foreground text-xs">Allowed members can invoke these tools using your account's credentials. Conversations are shared with channel participants, and usage is billed to your camelRun account.</p>
          </div>
          <p className="text-muted-foreground text-xs">Members' messages use your credit. These limits cap how much: each member, and the whole server.</p>
          <div className="flex flex-wrap gap-4"><div className="space-y-2"><Label htmlFor="managed-discord-rate">Turns per member per minute</Label><Input id="managed-discord-rate" type="number" min={1} max={100} step={1} value={perMinute} onChange={event => setPerMinute(Number(event.target.value))} /></div><div className="space-y-2"><Label htmlFor="managed-discord-daily">Turns per server per day</Label><Input id="managed-discord-daily" type="number" min={1} max={maxPerDay} step={1} value={perDay} onChange={event => setPerDay(Number(event.target.value))} /></div></div>
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !ready}>{busy && <Loader2 className="animate-spin" />}{binding.state === "disconnected" ? "Save and reactivate" : setup ? "Save and activate" : "Save configuration"}</Button></DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
    {definitionEditor && <DefinitionDialog definition={definitionEditor === "new" ? undefined : definitionEditor} forChannel={definitionEditor !== "new"} onClose={() => setDefinitionEditor(undefined)} onSaved={savedDefinition => { if (savedDefinition) setDefinition(savedDefinition.id); void definitions.reload(); }} />}
  </>;
}
