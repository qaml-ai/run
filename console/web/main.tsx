import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { BarChart3, Bot, Github, KeyRound, LogOut, MessageCircle, Rocket, Boxes, Loader2, FileCog, HardDrive, Wallet } from "lucide-react";
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
import { StartingCreditBanner } from "@/components/starting-credit";
import { api, useApi, type Me, type Billing, type AgentSummary } from "@/lib/api";
import { Link, usePath } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AgentsPage } from "@/pages/agents";
import { AgentPage } from "@/pages/agent";
import { ChannelsPage } from "@/pages/channels";
import { DefinitionsPage } from "@/pages/definitions";
import { ModelsPage } from "@/pages/models";
import { TokensPage } from "@/pages/tokens";
import { UsagePage } from "@/pages/usage";
import { BillingConfirmationPage } from "@/pages/billing-confirmation";
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
  { to: "quickstart", label: "Quickstart", icon: Rocket },
];

/** While `tenant` is signed in, offer the Camel Run tools to the browser's agent (WebMCP), where the browser has one. */
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
  const path = usePath();
  const [section, ...rest] = path.split("/");
  const isAgentsList = !section || (section === "agents" && !rest[0]);
  const billing = useApi<Billing>(me.data ? "/v1/billing" : undefined, 30_000);
  const agents = useApi<AgentSummary[]>(me.data && isAgentsList ? "/v1/agents" : undefined, 10_000);
  useWebMcp(me.data?.tenant);
  if (me.loading && !me.data) return <div className="text-muted-foreground flex h-dvh items-center justify-center"><Loader2 className="animate-spin" /></div>;
  if (!me.data) return <SignIn onSignedIn={() => void me.reload()} />;
  const page = section === "agents" && rest[0] ? <AgentPage id={rest[0]} />
    : section === "volumes" ? (rest[0] ? <VolumePage id={rest[0]} /> : <VolumesPage />)
    : section === "definitions" ? <DefinitionsPage />
    : section === "channels" ? <ChannelsPage />
    : section === "models" ? <ModelsPage me={me.data} />
    : section === "tokens" ? <TokensPage />
    : section === "usage" ? <UsagePage />
    : section === "billing" ? <BillingPage />
    : section === "quickstart" ? <QuickstartPage />
    : <AgentsPage agents={agents} billing={billing} />;
  const active = section || "agents";
  const who = me.data.login ?? me.data.tenant;
  // The shell stays quiet: ground-colored, split from the page by a rule, no art or display type.
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border flex shrink-0 flex-col border-b md:sticky md:top-0 md:h-dvh md:w-60 md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-4">
          <div className="min-w-0">
            <FullLogo className="h-5 w-auto" />
            <div className="text-muted-foreground mt-2 truncate text-xs">{location.host}</div>
          </div>
          <div className="md:hidden"><SignOut /></div>
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
        </nav>
        <div className="mt-auto hidden md:block">
          <Separator />
          <div className="flex items-center gap-3 px-3 py-3">
            <span aria-hidden="true" className="border-sidebar-border bg-sidebar-accent flex size-8 shrink-0 items-center justify-center border text-sm font-medium">
              {who[0]?.toUpperCase() ?? "?"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{who}</div>
              <div className="text-muted-foreground truncate text-xs">tenant {me.data.tenant}</div>
            </div>
            <SignOut />
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {active !== "billing" && (!isAgentsList || !!agents.data?.length) && <StartingCreditBanner billing={billing.data} />}
        <div className="px-4 py-6 md:px-10 md:py-8">
          <div className="mx-auto max-w-6xl">
            <PageErrorBoundary key={path}>{page}</PageErrorBoundary>
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

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const methods = useApi<{ github: boolean; token: boolean; org?: string; open?: boolean }>("/console/auth/methods");
  const [token, setToken] = useState("");
  const [error, setError] = useState(new URLSearchParams(location.search).get("error") ?? "");
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
        <ErrorAlert error={error || undefined} title="Sign-in failed" className="mb-0" />
        {methods.data?.github && (
          <div className="flex flex-col gap-3">
            <PixelButton size="hero" href="/console/auth/github" className="w-full"><Github className="size-3.5" aria-hidden="true" />Continue with GitHub</PixelButton>
            <p className="text-muted-foreground text-center text-xs text-balance">{methods.data.open
              ? "Any GitHub account can sign up."
              : `For members of the ${methods.data.org} GitHub organization.`}</p>
          </div>
        )}
        {methods.data?.github && (
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
          <PixelButton size="hero" type="submit" variant={methods.data?.github ? "secondary" : "primary"} className="w-full" loading={busy} disabled={!token.trim() || busy}>
            Sign in with token
          </PixelButton>
        </form>
      </div>
    </AuthLayout>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><TooltipProvider>{location.pathname === "/console/billing/confirm" ? <BillingConfirmationPage /> : <App />}</TooltipProvider></StrictMode>,
);
