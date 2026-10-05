import { StrictMode, useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUpRight, BookOpen, Github, LogOut, Rocket, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FullLogo } from "@/components/ui/logo";
import { PixelButton } from "@/components/ui/pixel-button";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthLayout } from "@/components/auth-layout";
import { ErrorAlert, PageErrorBoundary } from "@/components/common";
import { BillingBanner, BillingBalance } from "@/components/billing-banner";
import { BillingDialogs } from "@/components/billing-controls";
import { useBillingState } from "@/components/billing-state";
import { GetHelp } from "@/components/get-help";
import { SignedInAs } from "@/components/signed-in-as";
import { setHelpTenant } from "@/lib/help-context";
import { api, useApi, type Me, type Billing, type AgentSummary } from "@/lib/api";
import { DOCS } from "@/lib/docs";
import { groupOf, NAV, TABS } from "@/lib/nav";
import { navProgress, startFrom, startNext, useOnboarding } from "@/lib/onboarding";
import { Link, usePath } from "@/lib/router";
import { cn } from "@/lib/utils";
import { consoleLoginUrl, discordInstallNext } from "@/lib/discord-setup";
import { AccountPage } from "@/pages/account";
import { AgentsPage } from "@/pages/agents";
import { AgentPage } from "@/pages/agent";
import { ChannelsPage } from "@/pages/channels";
import { DefinitionsPage } from "@/pages/definitions";
import { ModelsPage } from "@/pages/models";
import { TokensPage } from "@/pages/tokens";
import { TelemetryPage } from "@/pages/telemetry";
import { UsagePage } from "@/pages/usage";
import { BillingConfirmationPage } from "@/pages/billing-confirmation";
import { BillingUnsubscribePage } from "@/pages/billing-unsubscribe";
import { BillingPage } from "@/pages/billing";
import { GetStartedPage } from "@/pages/start";
import { VolumePage, VolumesPage } from "@/pages/volumes";
import { PasswordForm } from "@/pages/password-sign-in";
import "@fontsource-variable/figtree";
import "@fontsource-variable/geist-mono";
import "./style.css";

const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);


/** The tabs of a nav group, on its list pages: links, so each tab keeps its own URL. */
function SectionTabs({ group, active }: { group: string; active: string }) {
  return (
    <nav aria-label="Section" className="-mx-1 mb-6 flex gap-1 overflow-x-auto border-b">
      {TABS[group].map(tab => (
        <Link key={tab.to} to={tab.to} aria-current={tab.to === active ? "page" : undefined} className={cn(
          "-mb-px shrink-0 border-b-2 px-2.5 py-2 text-sm transition-colors",
          tab.to === active ? "border-foreground text-foreground font-medium" : "text-muted-foreground hover:text-foreground border-transparent",
        )}>{tab.label}</Link>
      ))}
    </nav>
  );
}

const navItem = (active: boolean) => cn(
  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex shrink-0 items-center gap-2 px-2.5 py-1.5 text-sm transition-colors",
  active ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-muted-foreground",
);

/** While `tenant` is signed in, offer the camelRun tools to the browser's agent (WebMCP), where the browser has one. */
function useWebMcp(tenant: string | undefined) {
  useEffect(() => {
    // Loaded only where the browser has an agent to offer tools to: the tools bring zod and yaml with them.
    if (!tenant || !((document as any).modelContext ?? (navigator as any).modelContext)) return;
    const controller = new AbortController();
    void import("@/lib/webmcp").then(({ registerTools }) => registerTools(controller.signal));
    return () => controller.abort();
  }, [tenant]);
}

function App() {
  const me = useApi<Me>("/v1/me");
  useLayoutEffect(() => { setHelpTenant(me.data?.tenant); return () => setHelpTenant(undefined); }, [me.data?.tenant]);
  if (me.loading && !me.data) return <div className="text-muted-foreground flex h-dvh items-center justify-center"><Loader2 className="animate-spin" /></div>;
  if (!me.data) return <SignIn onSignedIn={() => void me.reload()} />;
  return <Console me={me.data} />;
}

function Console({ me }: { me: Me }) {
  const path = usePath();
  const [section, ...rest] = path.split("/");
  const billing = useApi<Billing>("/v1/billing", 30_000);
  const billingState = useBillingState(billing);
  const isAgentsList = section === "agents" && !rest[0];
  const agents = useApi<AgentSummary[]>(!section || isAgentsList ? "/v1/agents" : undefined, 10_000);
  // Home is Get started for an account with no agents (or a use-case start's deep link), and the agents list after.
  const home = !section && (!!startFrom(location.search) || agents.data?.length === 0);
  const starting = home || section === "start" || section === "quickstart";
  // One read for the nav's progress; on Get started, polled, so its steps tick as they happen.
  const onboarding = useOnboarding(starting ? 5_000 : undefined);
  const progress = navProgress(onboarding);
  useWebMcp(me.tenant);
  if (!section && !agents.data && !agents.error && !startFrom(location.search)) return <div className="text-muted-foreground flex h-dvh items-center justify-center"><Loader2 className="animate-spin" /></div>;
  const page = starting ? <GetStartedPage billing={billing.data} onboarding={onboarding} />
    : section === "agents" && rest[0] ? <AgentPage id={rest[0]} />
    : section === "volumes" ? (rest[0] ? <VolumePage id={rest[0]} /> : <VolumesPage />)
    : section === "definitions" ? <DefinitionsPage />
    : section === "channels" ? <ChannelsPage />
    : section === "models" ? <ModelsPage me={me} />
    : section === "tokens" ? <TokensPage tenant={me.tenant} />
    : section === "usage" ? <UsagePage />
    : section === "telemetry" ? <TelemetryPage me={me} />
    : section === "billing" ? <BillingPage state={billingState} />
    : section === "account" ? <AccountPage me={me} />
    : <AgentsPage agents={agents} billing={billing} />;
  const active = home ? "start" : section || "agents";
  const group = groupOf(active);
  const tabs = group && TABS[group.to] && !rest[0] ? group.to : undefined;
  // Get started stays in the nav, with its progress, until a path is done; then it sits beside Docs.
  const nav = NAV.filter(item => item.to !== "start" || !progress.complete || group?.to === "start");
  // The shell stays quiet: ground-colored, split from the page by a rule, no art or display type.
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border flex shrink-0 flex-col border-b md:sticky md:top-0 md:h-dvh md:w-60 md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-4">
          <div className="min-w-0">
            <FullLogo className="h-5 w-auto" />
            <div className="text-muted-foreground mt-2 truncate text-xs">{location.host}</div>
          </div>
          <div className="flex items-center gap-4 md:hidden"><BillingBalance state={billingState} mobile /><SignOut /></div>
        </div>
        <nav aria-label="Console" className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:gap-0.5 md:overflow-visible">
          {nav.map(({ to, label, icon: Icon }) => (
            <Link key={to} to={to} aria-current={group?.to === to ? "page" : undefined} className={navItem(group?.to === to)}>
              <Icon className="size-4" />{label}
              {to === "start" && !progress.complete && onboarding.loaded && <span className="text-muted-foreground ml-auto pl-2 font-mono text-xs" aria-label={`${progress.done} of ${progress.total} done`}>{progress.done}/{progress.total}</span>}
            </Link>
          ))}
          <Separator className="my-2 hidden md:block" />
          <a href={`${DOCS}/overview`} target="_blank" rel="noreferrer" className={navItem(false)}><BookOpen className="size-4" />Docs<ArrowUpRight className="ml-auto size-3" aria-hidden="true" /></a>
          {!nav.some(item => item.to === "start") && <Link to="start" className={navItem(false)}><Rocket className="size-4" />Get started</Link>}
          <GetHelp key={me.tenant} tenant={me.tenant} agentId={section === "agents" ? rest[0] : undefined} />
        </nav>
        <div className="mt-auto hidden md:block">
          <Separator />
          <BillingBalance state={billingState} />
          <div className="flex items-center gap-3 px-3 py-3">
            <SignedInAs me={me} />
            <SignOut />
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <BillingBanner state={billingState} hideStarting={active === "billing" || active === "start" || (isAgentsList && !agents.data?.length)} />
        <BillingDialogs state={billingState} />
        <div className="px-4 py-6 md:px-10 md:py-8">
          <div className="mx-auto max-w-6xl">
            {tabs && <SectionTabs group={tabs} active={active} />}
            <PageErrorBoundary key={path}>{active !== "billing" && <ErrorAlert error={billingState.error} />}{page}</PageErrorBoundary>
          </div>
        </div>
      </main>
    </div>
  );
}

function SignOut() {
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Sign out" onClick={async () => {
      await api("/console/auth/logout", { body: {} });
      location.assign("/console/");
    }}><LogOut /></Button>
  );
}

/** Google's "G", in the button's color: the console is monochrome. */
function GoogleMark({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor"><path d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.9-5.5 3.9-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.3 14.6 2.3 12 2.3 6.6 2.3 2.3 6.6 2.3 12s4.3 9.7 9.7 9.7c5.6 0 9.3-3.9 9.3-9.5 0-.6-.1-1.1-.2-1.6H12z" /></svg>;
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  // Adding Camel to Discord, or a use-case start (a landing page's deep link), resumes after sign-in.
  const next = discordInstallNext(location.pathname, location.search) ?? startNext(location.pathname, location.search);
  const methods = useApi<{ github: boolean; google?: boolean; password?: boolean; org?: string; open?: boolean }>("/console/auth/methods");
  const providers = !!(methods.data?.github || methods.data?.google);
  const error = new URLSearchParams(location.search).get("error") ?? "";
  const deleted = new URLSearchParams(location.search).get("deleted") === "1";
  // Every call to action here is a brand (pixel) button, as on camelStream's sign-in.
  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-xl font-semibold tracking-tight">camelRun</h1>
          <p className="text-muted-foreground text-sm text-balance">Sign in to manage your agents, model keys and API keys.</p>
        </div>
        {deleted && <Alert className="mb-0"><AlertTitle>Your account is deleted</AlertTitle><AlertDescription>Its data is being removed now. Signing in again makes a new, empty account.</AlertDescription></Alert>}
        <ErrorAlert error={error || undefined} title="Sign-in failed" className="mb-0" />
        {providers && (
          <div className="flex flex-col gap-3">
            {methods.data!.github && <PixelButton size="hero" href={consoleLoginUrl("github", next)} className="w-full"><Github className="size-3.5" aria-hidden="true" />Continue with GitHub</PixelButton>}
            {methods.data!.google && <PixelButton size="hero" href={consoleLoginUrl("google", next)} className="w-full"><GoogleMark className="size-3.5" />Continue with Google</PixelButton>}
            <p className="text-muted-foreground text-center text-xs text-balance">{!methods.data!.github
              ? "Any Google account can sign up."
              : methods.data!.open
                ? `Any GitHub${methods.data!.google ? " or Google" : ""} account can sign up.`
                : `For members of the ${methods.data!.org} GitHub organization${methods.data!.google ? ", or anyone with a Google account" : ""}.`}</p>
          </div>
        )}
        {/* Accounts an operator gave a password: a self-hosted runtime's, or one made without GitHub or Google. */}
        {methods.data?.password && <>
          {providers && <div className="text-muted-foreground flex items-center gap-3 text-xs"><Separator className="flex-1" />or<Separator className="flex-1" /></div>}
          <PasswordForm onSignedIn={onSignedIn} next={next} secondary={providers} />
        </>}
      </div>
    </AuthLayout>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><TooltipProvider>{location.pathname === "/console/billing/confirm" ? <BillingConfirmationPage /> : location.pathname === "/console/billing/unsubscribe" ? <BillingUnsubscribePage /> : <App />}</TooltipProvider></StrictMode>,
);
