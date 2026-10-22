import { Fragment, useState, type ReactNode } from "react";
import { ChevronRight, XIcon } from "lucide-react";
import type { AdminAccountAgent, AdminAccountDetail } from "../../../../src/admin-usage";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ago, count, fullDay, micros, modelName, plural, usd, useOps, when, type OpsRange } from "@/lib/ops";
import { cn } from "@/lib/utils";
import { ColumnChart, dayColumn, FOCUS } from "./charts";
import { KindBadge, Problem, Stat } from "./parts";

const SIGN_IN = { github: "GitHub", google: "Google", email: "email" } as const;

/**
 * One account, opened from a table: who it is, its credit, its model use in the range, what it connected, and each of
 * its live agents with how it is set up, down to the start of its system prompt.
 */
export function AccountDialog({ tenant, days, refresh, onClose }: { tenant: string | null; days: OpsRange; refresh: number; onClose: () => void }) {
  // Kept while the dialog closes, so its content does not vanish mid-animation.
  const [shown, setShown] = useState(tenant);
  if (tenant && tenant !== shown) setShown(tenant);
  const detail = useOps<AdminAccountDetail>(shown ? `/api/account?tenant=${encodeURIComponent(shown)}&days=${days}` : undefined, refresh);
  const data = detail.data?.account.tenant === shown ? detail.data : undefined;
  return (
    <Dialog open={!!tenant} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <DialogHeader className="bg-popover sticky top-0 z-10 border-b px-5 pt-4 pb-3.5 pr-12">
          {/* In the header, so it stays in reach while the account scrolls under it. */}
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2"><XIcon /><span className="sr-only">Close</span></Button>
          </DialogClose>
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <span className="min-w-0 break-all">{data?.account.name ?? shown}</span>
            {data && <KindBadge kind={data.account.kind} staff={data.account.staff} />}
            {data?.account.deleted && <span className="text-destructive text-xs font-normal">Being erased</span>}
          </DialogTitle>
          <DialogDescription>
            {data ? <Identity data={data} days={days} /> : `Last ${days} days`}
          </DialogDescription>
        </DialogHeader>
        <div className={cn("px-5 py-4 transition-opacity", detail.stale && "opacity-50")}>
          {data ? <Detail data={data} /> : detail.error ? <Problem error={detail.error} /> : (
            <div className="grid gap-4" aria-busy="true"><Skeleton className="h-16 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-40 w-full" /></div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Identity({ data, days }: { data: AdminAccountDetail; days: number }) {
  const { account } = data;
  const joined = account.signed_up_at ? `Signed up ${fullDay(account.signed_up_at)}${account.sign_in ? ` with ${SIGN_IN[account.sign_in]}` : ""}` : account.kind === "operator" ? "An admin tenant of the runtime (no account row)" : "Made by an operator";
  return <>{joined} · <span className="font-mono">{account.tenant}</span> · figures for the last {days} days</>;
}

function Block({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0", className)}>
      <h3 className="text-muted-foreground mb-2 text-xs">{title}</h3>
      {children}
    </section>
  );
}

function Detail({ data }: { data: AdminAccountDetail }) {
  const { account, usage } = data;
  const billing = account.billing === "prepaid" ? undefined : account.billing === "none" ? "Not charged" : undefined;
  return (
    <div className="grid gap-6">
      <dl className="bg-card grid grid-cols-2 gap-x-6 gap-y-4 border px-4 py-3.5 sm:grid-cols-4">
        <Stat label="Model responses" value={count(usage.responses)} detail={`${plural(usage.active_days, "active day")}`} />
        <Stat label="Model cost" value={usd(usage.cost)} detail={`${usd(usage.platform_cost)} on our keys`}
          hint="What its model calls, searches and the like cost at provider prices; the part on the platform's own keys is what we paid." />
        <Stat label="Credit left" value={billing ?? micros(account.balance)} detail={billing ? undefined : `${micros(account.purchased)} bought`} />
        <Stat label="Free credit given" value={micros(account.granted)} hint="Starting grants and credit an operator added." />
      </dl>

      <Block title="Model responses per day">
        <ColumnChart height={120} label={`${account.name}'s model responses per day`} series={[{ key: "responses", label: "responses", color: FOCUS }]}
          data={data.daily.map(row => ({ ...dayColumn(row.date, data.range.incomplete_date), values: [row.responses] }))} />
      </Block>

      <div className="grid gap-6 sm:grid-cols-2">
        <Block title="Models it used">
          {usage.models.length ? (
            <ul className="grid text-xs">
              {usage.models.map(model => (
                <li key={model.model} className="flex items-baseline justify-between gap-3 border-b py-1.5 last:border-b-0">
                  <span className="min-w-0 truncate" title={model.model}>{modelName(model.model).name} <span className="text-muted-foreground">{modelName(model.model).via}</span></span>
                  <span className="font-mono whitespace-nowrap tabular-nums">{count(model.responses)} <span className="text-muted-foreground">· {usd(model.cost)}</span></span>
                </li>
              ))}
            </ul>
          ) : <p className="text-muted-foreground text-xs">No model answered it in this range.</p>}
        </Block>
        <Block title="What it set up">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Channels</dt>
            <dd>{data.channels.length ? data.channels.map(channel => `${channel.name || "Unnamed"} (${channel.type})`).join(", ") : "None"}</dd>
            <dt className="text-muted-foreground">Own model keys</dt>
            <dd>{data.provider_keys.length ? data.provider_keys.join(", ") : "None"}</dd>
            <dt className="text-muted-foreground">MCP clients</dt>
            <dd>{data.mcp_clients.length ? data.mcp_clients.join(", ") : "None"}</dd>
            <dt className="text-muted-foreground">Also</dt>
            <dd>{[plural(data.counts.api_keys, "API key"), plural(data.counts.definitions, "definition"), plural(data.counts.volumes, "volume"), plural(data.counts.schedules, "schedule")]
              .map((text, index) => <Fragment key={text}>{index ? " · " : ""}<span className="whitespace-nowrap">{text}</span></Fragment>)}</dd>
          </dl>
        </Block>
      </div>

      <Block title={<>Agents <span className="font-mono">{count(data.live_agents)}</span> live{data.live_agents > data.agents.length ? `, the ${data.agents.length} most used shown` : ""}</>}>
        {data.agents.length ? (
          <ul className="border">
            {data.agents.map(agent => <AgentRow key={agent.agent} agent={agent} />)}
          </ul>
        ) : <p className="text-muted-foreground text-xs">No live agents.</p>}
      </Block>
    </div>
  );
}

const BUILTINS: Record<string, string> = {
  web_search: "Web search", x_search: "X search", web_fetch: "Reads web pages", schedule: "Schedules", delegate: "Sub-agents", agents: "Sub-agents", ask_user: "Asks a person",
  generate_image: "Makes images",
};

/** An agent as a row that opens: its model and activity first, then its tools, how it runs, and its system prompt. */
function AgentRow({ agent }: { agent: AdminAccountAgent }) {
  const [open, setOpen] = useState(false);
  const tools = [
    ...agent.builtins.map(name => BUILTINS[name] ?? name.replaceAll("_", " ")),
    ...agent.mcp_servers.map(host => `MCP: ${host}`),
    ...(agent.app_tools ? [`${plural(agent.app_tools, "app tool")}`] : []),
    ...(agent.openapi ? [`${plural(agent.openapi, "OpenAPI spec")}`] : []),
  ];
  const runs = [agent.schedules ? plural(agent.schedules, "schedule") : "", agent.channel ? `answers ${agent.channel}` : ""].filter(Boolean);
  return (
    <li className="border-b last:border-b-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="hover:bg-muted/60 grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 px-3 py-2 text-left text-xs sm:grid-cols-[1rem_minmax(0,1fr)_minmax(0,11rem)_auto]">
          <ChevronRight className={cn("text-muted-foreground size-3.5 transition-transform", open && "rotate-90")} aria-hidden="true" />
          <span className="min-w-0 truncate font-medium" title={agent.agent}>{agent.name}</span>
          <span className="text-muted-foreground hidden min-w-0 truncate sm:block" title={agent.model}>{modelName(agent.model).name}</span>
          <span className="text-muted-foreground font-mono whitespace-nowrap tabular-nums"><span className="text-foreground">{count(agent.responses)}</span> · {ago(agent.last_at)}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="bg-background grid gap-3 border-t px-3 py-3 pl-9 text-xs">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
              <dt className="text-muted-foreground">Model</dt><dd className="font-mono break-all">{agent.model}</dd>
              <dt className="text-muted-foreground">Tools</dt>
              <dd>{tools.length ? tools.join(" · ") : "None"}{agent.code_mode ? " · code mode" : " · code mode off"}</dd>
              <dt className="text-muted-foreground">Runs on</dt><dd>{runs.length ? runs.join(" · ") : "When it is called"}</dd>
              <dt className="text-muted-foreground">Activity</dt>
              <dd>{plural(agent.responses, "response")} · {plural(agent.end_users, "end user")} · last run {agent.last_at ? when(agent.last_at) : "not in this range"}</dd>
              {agent.definition && <><dt className="text-muted-foreground">Made from</dt><dd className="font-mono break-all">{agent.definition}</dd></>}
              <dt className="text-muted-foreground">Agent id</dt><dd className="font-mono break-all">{agent.agent}</dd>
            </dl>
            <div>
              <p className="text-muted-foreground mb-1.5">
                System prompt{agent.system_prompt_length > agent.system_prompt.length && <>: the first {count(agent.system_prompt.length)} of {count(agent.system_prompt_length)} characters</>}
              </p>
              {agent.system_prompt
                ? <pre className="bg-card max-h-64 overflow-auto border p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">{agent.system_prompt}</pre>
                : <p className="text-muted-foreground">None set.</p>}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
