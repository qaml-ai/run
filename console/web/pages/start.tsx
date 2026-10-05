import { useEffect, useState } from "react";
import { ArrowLeft, Code, MessageCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PixelButton } from "@/components/ui/pixel-button";
import { FirstRunPanel } from "@/components/brand";
import { LearnMore, PageHeader } from "@/components/common";
import { needsStartingCredit, StartingCreditHelp } from "@/components/starting-credit";
import { type Billing } from "@/lib/api";
import { startFrom, type Start, type useOnboarding } from "@/lib/onboarding";
import { Link } from "@/lib/router";
import { CodePath, Playground } from "./start-code";
import { DiscordPath } from "./start-discord";

/** Before a run can work: starting credit to unlock, or a balance to top up. */
function CreditNeeded({ billing }: { billing?: Billing }) {
  if (needsStartingCredit(billing)) return (
    <Alert className="mb-0">
      <AlertTitle>One step before your first run</AlertTitle>
      <AlertDescription><StartingCreditHelp credit={billing!.startingCredit} /> <Link className="underline underline-offset-4" to="billing">Open Billing</Link></AlertDescription>
    </Alert>
  );
  if (billing?.billing === "prepaid" && billing.balance <= 0) return (
    <Alert className="mb-0">
      <AlertTitle>Add credit to run agents</AlertTitle>
      <AlertDescription>Your balance is empty, so runs won't start. <Link className="underline underline-offset-4" to="billing">Add credit</Link></AlertDescription>
    </Alert>
  );
  return null;
}

/**
 * The console's home for a new account: what camelRun is, then a use-case start. Discord bots come first; the code
 * path is the quickstart, brought in. `?start=discord|code` (a landing page's deep link) opens a path directly.
 */
export function GetStartedPage({ billing, onboarding }: { billing?: Billing; onboarding: ReturnType<typeof useOnboarding> }) {
  const [start, setStartState] = useState<Start | undefined>(() => startFrom(location.search));
  const discord = onboarding.discord.data?.enabled;
  // Home is Get started only while an account has no agents: give it its own URL, so a first run here doesn't swap it for the agents list.
  useEffect(() => {
    if (location.pathname !== "/console/") return;
    history.replaceState(null, "", `/console/start${location.search}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  const setStart = (next?: Start) => {
    // The path is in the URL, so a reload or a shared link opens it again; Discord's own parameters are spent.
    history.replaceState(null, "", `/console/start${next ? `?start=${next}` : ""}`);
    dispatchEvent(new PopStateEvent("popstate"));
    setStartState(next);
  };
  if (start) return (
    <>
      <Button variant="ghost" size="sm" className="mb-3 -ml-2" onClick={() => setStart(undefined)}><ArrowLeft />All starts</Button>
      <PageHeader title={start === "discord" ? "Build a Discord bot" : "Build an agent"} docs={start === "discord" ? "channels" : "quickstart"}
        description={start === "discord"
          ? "Camel, our shared bot, answers @mentions in your server with the personality and tools you give it. No code, about three minutes."
          : "Try an agent here first, with no code; then run one from your own code, with your own tools."} />
      <div className="flex flex-col gap-4">
        <CreditNeeded billing={billing} />
        {start === "discord" ? <DiscordPath onboarding={onboarding} config={onboarding.discord.error ? { enabled: false } : onboarding.discord.data} /> : <CodePath onboarding={onboarding} billing={billing} />}
      </div>
    </>
  );
  const choices = [
    ...(discord !== false && !onboarding.discord.error ? [{ id: "discord" as const, icon: MessageCircle, title: "Build a Discord bot", description: "A bot that answers @mentions in your server: a helpful assistant, a dungeon master or your own. No code.", action: "Start with Discord" }] : []),
    { id: "code" as const, icon: Code, title: "Build an agent", description: "Try one right here in your browser, then run it with your own tools from TypeScript, Python or curl.", action: "Start building" },
  ];
  return (
    <>
      <FirstRunPanel art="liquid" eyebrow="GET STARTED" title="Durable agents, hosted"
        action={<LearnMore page="concepts">How camelRun works</LearnMore>}>
        camelRun runs your agents: the model loop, their history and files, and a sandbox for the code they write. Your tools
        stay in your code. Pick what to build.
      </FirstRunPanel>
      <div className="mt-4 flex flex-col gap-4">
        <CreditNeeded billing={billing} />
        <div className="grid gap-4 md:grid-cols-2">
          {choices.map(choice => (
            <Card key={choice.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><choice.icon className="size-4" />{choice.title}</CardTitle>
                <CardDescription>{choice.description}</CardDescription>
              </CardHeader>
              <CardContent><PixelButton onClick={() => setStart(choice.id)}>{choice.action}</PixelButton></CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Try an agent right now</CardTitle>
            <CardDescription>No code: this runs your prompt on an agent called Playground, on your account's default model, with no tools. It bills like any run.</CardDescription>
          </CardHeader>
          <CardContent><Playground agents={onboarding.agents.data} onRan={() => { void onboarding.agents.reload(); void onboarding.usage.reload(); }} /></CardContent>
        </Card>
      </div>
    </>
  );
}
