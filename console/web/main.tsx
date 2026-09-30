import { StrictMode, useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { BarChart3, Bot, CircleUser, Github, KeyRound, LogOut, MessageCircle, Rocket, Boxes, Loader2, FileCog, HardDrive, Wallet } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FullLogo } from "@/components/ui/logo";
import { PixelButton } from "@/components/ui/pixel-button";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthLayout } from "@/components/auth-layout";
import { PIXEL_STYLE } from "@/components/brand";
import { ErrorAlert, PageErrorBoundary } from "@/components/common";
import { BillingBanner, BillingBalance } from "@/components/billing-banner";
import { BillingDialogs } from "@/components/billing-controls";
import { useBillingState } from "@/components/billing-state";
import { GetHelp } from "@/components/get-help";
import { SignedInAs } from "@/components/signed-in-as";
import { setHelpTenant } from "@/lib/help-context";
import { api, useApi, type Me, type Billing, type AgentSummary } from "@/lib/api";
import { Link, usePath } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AccountPage } from "@/pages/account";
import { AgentsPage } from "@/pages/agents";
import { AgentPage } from "@/pages/agent";
import { ChannelsPage } from "@/pages/channels";
import { DefinitionsPage } from "@/pages/definitions";
import { ModelsPage } from "@/pages/models";
import { TokensPage } from "@/pages/tokens";
import { UsagePage } from "@/pages/usage";
import { BillingConfirmationPage } from "@/pages/billing-confirmation";
import { BillingUnsubscribePage } from "@/pages/billing-unsubscribe";
import { BillingPage } from "@/pages/billing";
import { QuickstartPage } from "@/pages/quickstart";
import { VolumePage, VolumesPage } from "@/pages/volumes";
import "@fontsource-variable/figtree";
import "@fontsource-variable/geist-mono";
import "./style.css";

const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

const NAV = [
  { to: "agents", label: "Agents", icon: Bot },
  { to: "definitions", label: "Definitions", icon: FileCog },
  { to: "channels", label: "Channels", icon: MessageCircle },
  { to: "volumes", label: "Volumes", icon: HardDrive },
  { to: "models", label: "Models & keys", icon: Boxes },
  { to: "tokens", label: "API tokens", icon: KeyRound },
  { to: "usage", label: "Usage", icon: BarChart3 },
  { to: "billing", label: "Billing", icon: Wallet },
  { to: "account", label: "Account", icon: CircleUser },
  { to: "quickstart", label: "Quickstart", icon: Rocket },
];

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
  const path = usePath();
  const [section, ...rest] = path.split("/");
  const isAgentsList = !section || (section === "agents" && !rest[0]);
  const billing = useApi<Billing>(me.data ? "/v1/billing" : undefined, 30_000);
  const billingState = useBillingState(billing);
  const agents = useApi<AgentSummary[]>(me.data && isAgentsList ? "/v1/agents" : undefined, 10_000);
  useWebMcp(me.data?.tenant);
  if (me.loading && !me.data) return <div className="text-muted-foreground flex h-dvh items-center justify-center"><Loader2 className="animate-spin" /></div>;
  if (!me.data) return <SignIn onSignedIn={() => void me.reload()} />;
  const page = section === "agents" && rest[0] ? <AgentPage id={rest[0]} />
    : section === "volumes" ? (rest[0] ? <VolumePage id={rest[0]} /> : <VolumesPage />)
    : section === "definitions" ? <DefinitionsPage />
    : section === "channels" ? <ChannelsPage />
    : section === "models" ? <ModelsPage me={me.data} />
    : section === "tokens" ? <TokensPage tenant={me.data.tenant} />
    : section === "usage" ? <UsagePage />
    : section === "billing" ? <BillingPage state={billingState} />
    : section === "account" ? <AccountPage me={me.data} />
    : section === "quickstart" ? <QuickstartPage />
    : <AgentsPage agents={agents} billing={billing} />;
  const active = section || "agents";
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
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:gap-0.5 md:overflow-visible">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link key={to} to={to} aria-current={active === to ? "page" : undefined} className={cn(
              "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex shrink-0 items-center gap-2 px-2.5 py-1.5 text-sm transition-colors",
              active === to ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-muted-foreground",
            )}>
              <Icon className="size-4" />{label}
            </Link>
          ))}
          <GetHelp key={me.data.tenant} tenant={me.data.tenant} agentId={section === "agents" ? rest[0] : undefined} />
        </nav>
        <div className="mt-auto hidden md:block">
          <Separator />
          <BillingBalance state={billingState} />
          <div className="flex items-center gap-3 px-3 py-3">
            <SignedInAs me={me.data} />
            <SignOut />
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <BillingBanner state={billingState} hideStarting={active === "billing" || (isAgentsList && !agents.data?.length)} />
        <BillingDialogs state={billingState} />
        <div className="px-4 py-6 md:px-10 md:py-8">
          <div className="mx-auto max-w-6xl">
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
  const methods = useApi<{ github: boolean; google?: boolean; token: boolean; org?: string; open?: boolean }>("/console/auth/methods");
  const providers = !!(methods.data?.github || methods.data?.google);
  const [token, setToken] = useState("");
  const [error, setError] = useState(new URLSearchParams(location.search).get("error") ?? "");
  const deleted = new URLSearchParams(location.search).get("deleted") === "1";
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try { await api("/console/auth/token", { body: { token: token.trim() } }); history.replaceState(null, "", "/console/"); onSignedIn(); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  // Every call to action here is a brand (pixel) button, as on camelStream's sign-in.
  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-xl font-semibold tracking-tight">camelRun</h1>
          <p className="text-muted-foreground text-sm text-balance">Sign in to manage your agents, model keys and API tokens.</p>
        </div>
        {deleted && <Alert className="mb-0"><AlertTitle>Your account is deleted</AlertTitle><AlertDescription>Its data is being removed now. Signing in again makes a new, empty account.</AlertDescription></Alert>}
        <ErrorAlert error={error || undefined} title="Sign-in failed" className="mb-0" />
        {providers && (
          <div className="flex flex-col gap-3">
            {methods.data!.github && <PixelButton size="hero" href="/console/auth/github" className="w-full"><Github className="size-3.5" aria-hidden="true" />Continue with GitHub</PixelButton>}
            {methods.data!.google && <PixelButton size="hero" href="/console/auth/google" className="w-full"><GoogleMark className="size-3.5" />Continue with Google</PixelButton>}
            <p className="text-muted-foreground text-center text-xs text-balance">{!methods.data!.github
              ? "Any Google account can sign up."
              : methods.data!.open
                ? `Any GitHub${methods.data!.google ? " or Google" : ""} account can sign up.`
                : `For members of the ${methods.data!.org} GitHub organization${methods.data!.google ? ", or anyone with a Google account" : ""}.`}</p>
          </div>
        )}
        {providers && (
          <div className="relative">
            <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
            <div className="relative flex justify-center">
              <span className="bg-background text-muted-foreground px-2 text-[10px] uppercase tracking-[0.3em]" style={PIXEL_STYLE}>or</span>
            </div>
          </div>
        )}
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="token">Operator or API token</Label>
            <Input id="token" type="password" autoComplete="off" placeholder="art_…" value={token} onChange={event => setToken(event.target.value)} />
          </div>
          <PixelButton size="hero" type="submit" variant={providers ? "secondary" : "primary"} className="w-full" loading={busy} disabled={!token.trim() || busy}>
            Sign in with token
          </PixelButton>
        </form>
      </div>
    </AuthLayout>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><TooltipProvider>{location.pathname === "/console/billing/confirm" ? <BillingConfirmationPage /> : location.pathname === "/console/billing/unsubscribe" ? <BillingUnsubscribePage /> : <App />}</TooltipProvider></StrictMode>,
);
