import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PixelButton } from "@/components/ui/pixel-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FirstRunPanel } from "@/components/brand";
import { ErrorAlert, PageHeader } from "@/components/common";
import { needsStartingCredit, StartingCreditHelp } from "@/components/starting-credit";
import { formatMicros, formatTime, type useApi, type AgentSummary, type Billing } from "@/lib/api";
import { Link, navigate } from "@/lib/router";

export function AgentStatus({ agent }: { agent: Pick<AgentSummary, "running" | "connected"> }) {
  if (agent.running) return <Badge variant="live">Running</Badge>;
  if (agent.connected) return <Badge variant="secondary">Connected</Badge>;
  return <Badge variant="outline" className="text-muted-foreground">Asleep</Badge>;
}

export function AgentsPage({ agents, billing }: {
  agents: ReturnType<typeof useApi<AgentSummary[]>>;
  billing: ReturnType<typeof useApi<Billing>>;
}) {
  const needsCredit = needsStartingCredit(billing.data);
  const emptyBalance = billing.data?.billing === "prepaid" && billing.data.balance <= 0;
  const cardCheck = needsCredit && !!billing.data!.startingCredit.cardCheck;
  return (
    <>
      <PageHeader
        title="Agents"
        description="Agents in your tenant. Your application creates them with the SDK or POST /v1/agents."
        actions={<Button variant="outline" size="sm" onClick={() => void agents.reload()}><RefreshCw />Refresh</Button>}
      />
      <ErrorAlert error={agents.error} />
      <ErrorAlert error={agents.data?.length === 0 ? billing.error : undefined} />
      {(agents.loading && !agents.data) || (agents.data?.length === 0 && !billing.data && !billing.error) ? <Skeleton className="h-40 w-full" />
        : agents.data?.length === 0 && billing.data ? (
          <FirstRunPanel hero art="liquid" eyebrow="FIRST AGENT" title="No agents yet"
            action={<PixelButton size="hero" asChild><Link to={emptyBalance ? "billing" : "quickstart"}>{cardCheck ? "Get starting credit" : emptyBalance ? "Add credit" : "Open quickstart"}</Link></PixelButton>}>
            {needsCredit ? <StartingCreditHelp credit={billing.data!.startingCredit} />
              : emptyBalance ? "Add credit to start running agents."
              : billing.data?.startingCredit?.status === "granted" && billing.data.freeCredit
                ? <>You started with {formatMicros(billing.data.startingCredit.amount)} of credit. Follow the Quickstart to create your first agent.</>
                : billing.data?.billing === "none"
                  ? <>Add a model key under <Link className="text-foreground underline underline-offset-4" to="models">Models & keys</Link>, then follow the Quickstart to create your first agent.</>
                  : <>Follow the <Link className="text-foreground underline underline-offset-4" to="quickstart">Quickstart</Link> to create your first agent.</>}
          </FirstRunPanel>
        ) : !!agents.data?.length && (
          <div className="bg-card border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Type</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Session expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.data.map(agent => (
                  <TableRow key={agent.id} className="cursor-pointer" onClick={() => navigate(`agents/${agent.id}`)}>
                    <TableCell className="font-medium"><Link to={`agents/${agent.id}`}>{agent.name}</Link></TableCell>
                    <TableCell className="text-muted-foreground hidden sm:table-cell">{agent.type}</TableCell>
                    <TableCell className="font-mono text-xs">{agent.model}</TableCell>
                    <TableCell><AgentStatus agent={agent} /></TableCell>
                    <TableCell className="text-muted-foreground hidden lg:table-cell">{agent.expiresAt === null ? "Never" : formatTime(agent.expiresAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
    </>
  );
}
