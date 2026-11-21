import { useEffect, useState } from "react";
import { ArrowLeft, Code } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PixelButton } from "@/components/ui/pixel-button";
import { FirstRunPanel } from "@/components/brand";
import { LearnMore, PageHeader } from "@/components/common";
import { type Billing } from "@/lib/api";
import { startFrom, type Start, type useOnboarding } from "@/lib/onboarding";
import { Link } from "@/lib/router";
import { CodePath, Playground } from "./start-code";

function CreditNeeded({ billing }: { billing?: Billing }) {
  if (billing && billing.balanceUsd <= 0) {
    return (
      <Alert className="mb-0">
        <AlertTitle>Balance is empty</AlertTitle>
        <AlertDescription>
          Your prepaid credit balance is empty, so runs on platform-billed models may fail unless you add credit or configure your own provider key on{" "}
          <Link className="underline underline-offset-4" to="models">Models &amp; keys</Link>.
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}

/**
 * The console's home for a new account: what camelRun is, then the code path and in-browser playground.
 */
export function GetStartedPage({ billing, onboarding }: { billing?: Billing; onboarding: ReturnType<typeof useOnboarding> }) {
  const [start, setStartState] = useState<Start | undefined>(() => startFrom(location.search));
  useEffect(() => {
    if (location.pathname !== "/console/") return;
    history.replaceState(null, "", `/console/start${location.search}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  const setStart = (next?: Start) => {
    history.replaceState(null, "", `/console/start${next ? `?start=${next}` : ""}`);
    dispatchEvent(new PopStateEvent("popstate"));
    setStartState(next);
  };
  if (start) {
    return (
      <>
        <Button variant="ghost" size="sm" className="mb-3 -ml-2" onClick={() => setStart(undefined)}>
          <ArrowLeft />All starts
        </Button>
        <PageHeader
          title="Build an agent"
          docs="quickstart"
          description="Try an agent here first, with no code; then run one from your own code against the CamelRun v2 API."
        />
        <div className="flex flex-col gap-4">
          <CreditNeeded billing={billing} />
          <CodePath onboarding={onboarding} />
        </div>
      </>
    );
  }
  return (
    <>
      <FirstRunPanel
        art="liquid"
        eyebrow="GET STARTED"
        title="Durable agents, hosted"
        action={<LearnMore page="concepts">How camelRun works</LearnMore>}
      >
        camelRun v2 runs your agents on Cloudflare Durable Objects and Firecracker sandboxes: the model loop, durable history, Git-backed repositories, and tools. Pick how to start.
      </FirstRunPanel>
      <div className="mt-4 flex flex-col gap-4">
        <CreditNeeded billing={billing} />
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Code className="size-4" />Build an agent</CardTitle>
              <CardDescription>
                Try one right here in your browser, then run it from TypeScript, Python or curl using CamelRun v2.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PixelButton onClick={() => setStart("code")}>Start building</PixelButton>
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Try an agent right now</CardTitle>
            <CardDescription>
              No code: this runs your prompt on an agent keyed <span className="font-mono">playground</span> on your account&apos;s default model, with no tools.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Playground
              agents={onboarding.agentList}
              onRan={() => {
                void onboarding.agents.reload();
                void onboarding.usage.reload();
              }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
