import { StrictMode, useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Loader2, LogOut, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RunLogo } from "@/components/ui/logo";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BillingBalance, BillingBanner } from "@/components/billing-banner";
import { ErrorAlert, PageErrorBoundary } from "@/components/common";
import { ConsoleNav } from "@/components/console-nav";
import { SignedInAs } from "@/components/signed-in-as";
import { api, useApi, type AgentSummary, type Billing, type Me } from "@/lib/api";
import { documentTitle, groupOf, redirectFor, TABS } from "@/lib/nav";
import { homeIsGetStarted, navProgress, startFrom, useOnboarding } from "@/lib/onboarding";
import { Link, navigate, usePath, useSearch } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AccountPage } from "@/pages/account";
import { AgentPage } from "@/pages/agent";
import { AgentsPage } from "@/pages/agents";
import { BillingPage } from "@/pages/billing";
import { ChannelsPage } from "@/pages/channels";
import { DefinitionsPage } from "@/pages/definitions";
import { ModelsPage } from "@/pages/models";
import { OverviewPage } from "@/pages/overview";
import { RepoPage, ReposPage } from "@/pages/repos";
import { SignIn } from "@/pages/sign-in";
import { GetStartedPage } from "@/pages/start";
import { TokensPage } from "@/pages/tokens";
import { UsagePage } from "@/pages/usage";
import { WebhooksPage } from "@/pages/webhooks";
import "@fontsource-variable/figtree";
import "@fontsource-variable/geist-mono";
import "./style.css";

const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

function SectionTabs({ group, active }: { group: string; active: string }) {
  return (
    <nav aria-label="Section" className="-mx-1 mb-6 flex gap-1 overflow-x-auto border-b">
      {TABS[group].map(tab => (
        <Link
          key={tab.to}
          to={tab.to}
          aria-current={tab.to === active ? "page" : undefined}
          className={cn(
            "-mb-px shrink-0 border-b-2 px-2.5 py-2 text-sm transition-colors",
            tab.to === active
              ? "border-foreground text-foreground font-medium"
              : "text-muted-foreground hover:text-foreground border-transparent",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

function App() {
  const me = useApi<Me>("/v2/me");
  if (me.loading && !me.data) {
    return (
      <div className="text-muted-foreground flex h-dvh items-center justify-center">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  if (!me.data) return <SignIn onSignedIn={() => void me.reload()} />;
  return <Console me={me.data} />;
}

function Console({ me }: { me: Me }) {
  const path = usePath();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [path]);
  const search = useSearch();
  const [section, ...rest] = path.split("/");

  const redirect = redirectFor(path, search);
  useLayoutEffect(() => {
    if (redirect) navigate(redirect, { replace: true });
  }, [redirect]);

  const billing = useApi<Billing>("/v2/billing", 30_000);
  const agents = useApi<{ agents: AgentSummary[] }>(!section ? "/v2/agents" : undefined, 10_000);

  const home = !section && homeIsGetStarted(location.search, agents.data?.agents.length);
  const starting = home || section === "start" || section === "quickstart";
  const onboarding = useOnboarding(starting ? 5_000 : undefined);
  const progress = navProgress(onboarding, starting ? startFrom(location.search) : undefined);

  const title = documentTitle(section, home);
  useEffect(() => {
    document.title = title;
  }, [title]);

  if (redirect || (!section && !agents.data && !agents.error && !startFrom(location.search))) {
    return (
      <div className="text-muted-foreground flex h-dvh items-center justify-center">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const page = starting ? (
    <GetStartedPage billing={billing.data} onboarding={onboarding} />
  ) : section === "agents" && rest[0] ? (
    <AgentPage id={rest[0]} />
  ) : section === "repos" ? (
    rest[0] ? <RepoPage id={rest[0]} /> : <ReposPage />
  ) : section === "definitions" ? (
    <DefinitionsPage />
  ) : section === "channels" ? (
    <ChannelsPage />
  ) : section === "webhooks" ? (
    <WebhooksPage />
  ) : section === "models" ? (
    <ModelsPage />
  ) : section === "tokens" ? (
    <TokensPage tenant={me.tenantId} />
  ) : section === "usage" ? (
    <UsagePage />
  ) : section === "billing" ? (
    <BillingPage billing={billing} me={me} />
  ) : section === "account" ? (
    <AccountPage me={me} />
  ) : !section ? (
    <OverviewPage billing={billing.data} />
  ) : (
    <AgentsPage />
  );

  const active = home ? "start" : groupOf(section) ? section : "agents";
  const group = groupOf(active);
  const tabs = group && TABS[group.to] && !rest[0] ? group.to : undefined;
  const startPlace = !progress.complete || group?.to === "start" ? "top" : "footer";
  const startBadge = !progress.complete && onboarding.loaded && (
    <span className="text-muted-foreground ml-auto pl-2 font-mono text-xs" aria-label={`${progress.done} of ${progress.total} done`}>
      {progress.done}/{progress.total}
    </span>
  );

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border flex shrink-0 flex-col border-b md:sticky md:top-0 md:h-dvh md:w-60 md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-4 py-3 md:px-5 md:pt-5 md:pb-4">
          <div className="min-w-0">
            <RunLogo />
            <div className="text-muted-foreground mt-2 hidden truncate text-xs md:block">{location.host}</div>
          </div>
          <div className="flex items-center gap-2 md:hidden">
            <Button variant="ghost" size="icon-sm" aria-label="Open navigation" onClick={() => setMenuOpen(true)}>
              <Menu />
            </Button>
            <BillingBalance billing={billing.data} mobile />
            <SignOut />
          </div>
        </div>
        <div className="hidden md:block">
          <ConsoleNav active={active} start={{ place: startPlace, progress: startBadge }} />
        </div>
        <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Console navigation</DialogTitle>
              <DialogDescription>Agents, repositories, and account settings.</DialogDescription>
            </DialogHeader>
            <div className="console-mobile-nav">
              <ConsoleNav active={active} start={{ place: startPlace, progress: startBadge }} />
            </div>
          </DialogContent>
        </Dialog>
        <div className="mt-auto hidden md:block">
          <Separator />
          <BillingBalance billing={billing.data} />
          <div className="flex items-center gap-3 px-3 py-3">
            <SignedInAs me={me} />
            <SignOut />
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <BillingBanner billing={billing.data} hide={active === "billing" || active === "start"} />
        <div className={cn("px-4 md:px-10 md:py-8", section === "agents" && rest[0] ? "py-3" : "py-6")}>
          <div className="mx-auto max-w-6xl">
            {tabs && <SectionTabs group={tabs} active={active} />}
            <PageErrorBoundary key={path}>
              {active !== "billing" && <ErrorAlert error={billing.error} />}
              {page}
            </PageErrorBoundary>
          </div>
        </div>
      </main>
    </div>
  );
}

function SignOut() {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Sign out"
      onClick={async () => {
        await api("/console/auth/logout", { method: "POST", body: {} });
        location.assign("/console/");
      }}
    >
      <LogOut />
    </Button>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
