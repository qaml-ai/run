import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PixelButton } from "@/components/ui/pixel-button";
import { ErrorAlert, LearnMore } from "@/components/common";
import { api, type Definition, type ManagedDiscordConfig } from "@/lib/api";
import { DISCORD_STARTER_PREFIX, discordServer, discordSteps, type useOnboarding } from "@/lib/onboarding";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { DefinitionDialog } from "./definitions";
import { ManagedDiscordDialog, type SetupDefaults } from "./discord-managed";
import { Checklist, NextSteps, StepCard } from "./start-code";

/** Each starter is a definition: a prompt, and only builtins a server may use (never schedule). */
export const STARTERS = [
  {
    id: "assistant", name: "Server assistant", blurb: "Answers questions, explains, summarizes and looks things up on the web.", builtins: ["web_search", "web_fetch"],
    prompt: `You are Camel, a friendly, knowledgeable assistant in this Discord server. Answer questions, explain things, summarize discussions and help members get unstuck. Search the web when a question needs current information, and say where an answer came from.

Keep replies short and conversational: usually under 120 words and always under 1,900 characters, with short paragraphs and lists only when they help. Address the person who mentioned you. If a request is unclear, ask one question. Be honest about what you don't know. Members must mention you in every message in a server or thread; mention this if someone seems to expect otherwise.`,
  },
  {
    id: "dungeon-master", name: "Dungeon master", blurb: "Runs a cooperative fantasy adventure, and remembers every player's character.", builtins: [],
    prompt: `You are Ember, a witty, atmospheric dungeon master running a cooperative fantasy adventure in this Discord channel. The conversation history is the world: keep continuity with it.

Open at the Sunken Observatory, a lighthouse beneath a lake that has lit up for the first time in a hundred years, with something inside ringing its bell. Give the first player a vivid opening, ask their character's name and one talent, and offer three actions; players can always invent another.

Keep replies under 180 words and 1,900 characters, in short paragraphs, with at most one emoji. Be playful and welcoming; keep danger cinematic, not graphic. Tie each character to the member who plays them. Never choose a player's action. Track health (start at 10), inventory (one item tied to their talent) and discoveries; never silently restore or invent them. When chance matters, ask the player to roll a d20 and report it. Answer "join", "recap", "inventory" and "status" as plain messages. End each action reply with a decision or question. Players must mention you on every turn.`,
  },
  {
    id: "blank", name: "Start blank", blurb: "A plain helpful assistant: write its personality yourself, below.", builtins: [],
    prompt: "You are Camel, a helpful assistant in this Discord server. Keep replies short: always under 1,900 characters. Members must mention you on every turn.",
  },
] as const;

/** A server's first setup from here: open to everyone in the chosen channels, so tighter limits than the dialog's own. */
export const ONBOARDING_LIMITS = { perSenderPerMinute: 3, turnsPerDay: 50 } as const;

export function DiscordPath({ onboarding, config }: { onboarding: ReturnType<typeof useOnboarding>; config?: ManagedDiscordConfig }) {
  const query = new URLSearchParams(location.search);
  const [error, setError] = useState(query.get("discord_error") ?? undefined);
  const [busy, setBusy] = useState<string>();
  const [settingUp, setSettingUp] = useState(false);
  const [editing, setEditing] = useState<Definition>();
  const [chosen, setChosen] = useState<string>();
  const definitions = onboarding.definitions.data;
  const server = discordServer(onboarding.bindings.data?.bindings, query.get("discord_server") ?? undefined);
  const steps = discordSteps({ definitions, server, agents: onboarding.agents.data });
  const [starterDone, added, ready, replied] = steps.map(step => step.done);
  // The server's own definition once it is set up; before, the starter picked here, else the newest one a starter made.
  const starter = definitions?.find(definition => definition.id === server?.channel?.definition)
    ?? definitions?.find(definition => definition.id === chosen)
    ?? definitions?.filter(definition => definition.name.startsWith(DISCORD_STARTER_PREFIX)).sort((a, b) => b.createdAt - a.createdAt)[0];
  // Back from Discord with a server that still needs its channels: open its setup once.
  const [autoOpened, setAutoOpened] = useState(false);
  if (!autoOpened && server && !server.channel && query.get("discord_server") === server.guildId && config?.enabled) { setAutoOpened(true); setSettingUp(true); }
  if (config && !config.enabled) return (
    <ErrorAlert title="Camel's Discord bot isn't available here" error="This runtime doesn't offer the shared Camel bot. Connect your own Discord bot under Channels instead." />
  );
  const install = `${config?.installPath ?? "/console/discord/install"}?from=start`;
  async function pick(id: (typeof STARTERS)[number]["id"]) {
    const entry = STARTERS.find(starter => starter.id === id)!;
    setBusy(id); setError(undefined);
    try {
      // Picking a starter again reuses the definition it made.
      const name = `${DISCORD_STARTER_PREFIX}${entry.name}`;
      const made = definitions?.find(definition => definition.name === name)
        ?? await api<Definition>("/v1/definitions", { body: { name, systemPrompt: entry.prompt, builtins: entry.builtins } });
      setChosen(made.id);
      await onboarding.definitions.reload();
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(undefined); }
  }
  const defaults: SetupDefaults = { definition: starter?.id, public: true, ...ONBOARDING_LIMITS };
  const reload = () => { void onboarding.bindings.reload(); void onboarding.definitions.reload(); };
  const channel = server?.allowedChannelIds[0];
  return (
    <div className="flex flex-col gap-4">
      <Checklist label="YOUR DISCORD BOT" steps={steps} />
      <ErrorAlert error={error} title="Adding Camel to Discord" className="mb-0" />
      <StepCard n={1} title={steps[0].label} done={starterDone}
        description="Its personality and tools. You can change everything later.">
        <div className="grid gap-3 md:grid-cols-3">
          {STARTERS.map(entry => {
            const made = starter?.name === `${DISCORD_STARTER_PREFIX}${entry.name}`;
            return (
              <button key={entry.id} type="button" disabled={!!busy} onClick={() => void pick(entry.id)} aria-pressed={made}
                className={cn("bg-card hover:bg-muted flex flex-col items-start gap-1 border p-3 text-left transition-colors disabled:opacity-60", made && "border-foreground")}>
                <span className="flex items-center gap-2 text-sm font-medium">{busy === entry.id ? <Loader2 className="size-3.5 animate-spin" /> : made && <Check className="size-3.5 text-[var(--chart-1)]" />}{entry.name}</span>
                <span className="text-muted-foreground text-xs">{entry.blurb}</span>
              </button>
            );
          })}
        </div>
        {starter && <p className="text-muted-foreground text-xs">{server?.channel
          ? <>Your server uses <span className="text-foreground">{starter.name.replace(DISCORD_STARTER_PREFIX, "")}</span>. To switch, choose another definition in step 3.</>
          : <>Your bot will be the <span className="text-foreground">{starter.name.replace(DISCORD_STARTER_PREFIX, "")}</span>. Pick another to switch.</>}</p>}
      </StepCard>
      <StepCard n={2} title={steps[1].label} done={added}
        description="One Discord authorization: choose a server you manage. Camel can read and send messages only where you allow it, and never gets Administrator.">
        {server ? <p className="text-sm">Camel is in <span className="font-medium">{server.guildName || server.guildId}</span>. <a className="underline underline-offset-4" href={install}>Add it to another server</a></p>
          : <div><PixelButton href={install} aria-disabled={!starterDone} className={cn(!starterDone && "pointer-events-none opacity-50")}>Add Camel to Discord</PixelButton>
            {!starterDone && <p className="text-muted-foreground mt-2 text-xs">Pick a starter first.</p>}</div>}
      </StepCard>
      <StepCard n={3} title={steps[2].label} done={ready}
        description={<>Members' messages use your credit; limits: {ONBOARDING_LIMITS.perSenderPerMinute} turns per member per minute and {ONBOARDING_LIMITS.turnsPerDay} per server per day, which you can change here.</>}>
        {server && <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setSettingUp(true)} variant={ready ? "outline" : "default"}>{ready ? "Change channels and limits" : "Choose channels"}</Button>
          {server.channel && <Badge variant={server.state === "active" ? "live" : "outline"}>{server.state}</Badge>}
        </div>}
      </StepCard>
      <StepCard n={4} title={steps[3].label} done={replied}
        description="In an allowed channel, type @Camel, pick the bot with the APP badge, and say hello. It answers only when mentioned, in every message.">
        {ready && <div className="flex flex-col gap-2">
          <Input aria-label="Test message" readOnly className="max-w-sm font-mono" value={`@Camel hello`} onFocus={event => event.target.select()} />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button variant="outline" asChild><a href={`https://discord.com/channels/${server!.guildId}${channel ? `/${channel}` : ""}`} target="_blank" rel="noreferrer">Open Discord</a></Button>
            {!replied && <span className="text-muted-foreground flex items-center gap-2 text-xs"><Loader2 className="size-3 animate-spin" />This ticks when Camel gets its first mention.</span>}
          </div>
        </div>}
      </StepCard>
      <Card>
        <CardHeader>
          <CardTitle>Then: tune its personality and tools</CardTitle>
          <CardDescription>Its prompt, model and tools are a definition: edit it and every conversation in the server takes the change between turns.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!added || !starter} onClick={() => setEditing(starter)}>Edit personality and tools</Button>
            {ready ? <Button variant="outline" asChild><Link to="channels">Server settings</Link></Button> : <Button variant="outline" disabled>Server settings</Button>}
          </div>
          {!ready && <p className="text-muted-foreground text-xs">{added ? "Available once you've chosen where it answers." : "Available once Camel is in your server."}</p>}
        </CardContent>
      </Card>
      <NextSteps>
        <li><LearnMore page="channels">Your own Discord bot</LearnMore>: your bot's name and avatar, under Channels</li>
        <li><LearnMore page="limits">Limits</LearnMore>: servers, turns and rates</li>
      </NextSteps>
      {settingUp && server && config && <ManagedDiscordDialog config={config} binding={server} defaults={defaults} onClose={() => setSettingUp(false)} onSaved={reload} />}
      {editing && <DefinitionDialog definition={editing} forChannel={!!server?.channel} onClose={() => setEditing(undefined)} onSaved={() => void onboarding.definitions.reload()} />}
    </div>
  );
}
