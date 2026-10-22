import { useState } from "react";
import { BarChart3 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorAlert, PageHeader, Stats } from "@/components/common";
import { formatCost, formatNumber, useApi, type Usage, type Workspace } from "@/lib/api";
import { Link } from "@/lib/router";
import { useWorkspace } from "@/lib/workspace";

export function UsagePage() {
  const [days, setDays] = useState("30");
  // The sidebar's switcher and this filter are one choice, kept in ?ws=.
  const { ws, setWorkspace } = useWorkspace();
  const workspaceId = ws ?? "all";
  const setWorkspaceId = (value: string) => setWorkspace(value === "all" ? undefined : value);
  const workspaces = useApi<Workspace[]>("/v1/workspaces");
  const usage = useApi<Usage>(`/v1/usage?days=${days}${workspaceId === "all" ? "" : `&workspaceId=${encodeURIComponent(workspaceId)}`}`);
  const totals = usage.data?.totals;
  return (
    <>
      <PageHeader title="Usage" docs="pricing" description="Model and tool usage from your agents. Model costs use provider reports when available and otherwise list-price estimates. Billing includes applicable provider credit funding costs."
        actions={
          <div className="flex gap-2"><Select value={workspaceId} onValueChange={setWorkspaceId}>
            <SelectTrigger className="w-48" aria-label="Workspace"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All workspaces</SelectItem><SelectItem value="unassigned">Unassigned</SelectItem>{workspaces.data?.map(workspace => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}{workspace.archived ? " (archived)" : ""}</SelectItem>)}</SelectContent>
          </Select><Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last 24 hours</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select></div>
        } />
      <ErrorAlert error={usage.error} />
      {!usage.data ? <Skeleton className="h-64 w-full" /> : (
        <>
          <Stats items={[
            { label: "Responses", value: formatNumber(totals!.responses) },
            { label: "Input tokens", value: formatNumber(totals!.input + totals!.cacheRead + totals!.cacheWrite) },
            { label: "Output tokens", value: formatNumber(totals!.output) },
            { label: "Usage cost", value: formatCost(totals!.cost) },
          ]} />
          {workspaceId === "all" && !!usage.data.workspaces?.length && <div className="mb-6 border bg-card"><Table>
            <TableHeader><TableRow><TableHead>Workspace</TableHead><TableHead className="text-right">Responses</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader>
            <TableBody>{usage.data.workspaces.map(row => <TableRow key={row.id ?? "unassigned"}>
              <TableCell><button className="hover:underline" onClick={() => setWorkspaceId(row.id ?? "unassigned")}>{row.name}</button></TableCell>
              <TableCell className="text-right font-mono">{formatNumber(row.responses)}</TableCell><TableCell className="text-right font-mono">{formatCost(row.cost)}</TableCell>
            </TableRow>)}</TableBody>
          </Table></div>}
          {usage.data.days.length === 0 ? <EmptyState icon={<BarChart3 />} title="No usage in this period" action={<Button size="sm" variant="outline" asChild><Link to="start">Run an agent</Link></Button>}>Each model response your agents make shows here, with its tokens and cost.</EmptyState> : (
            <div className="bg-card border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Day</TableHead><TableHead>Model</TableHead><TableHead className="text-right">Responses</TableHead>
                    <TableHead className="text-right">Input</TableHead><TableHead className="text-right">Cached</TableHead>
                    <TableHead className="text-right">Output</TableHead><TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...usage.data.days].reverse().map(row => (
                    <TableRow key={`${row.day} ${row.model} ${row.kind}`}>
                      <TableCell className="tabular-nums">{row.day}</TableCell>
                      <TableCell className="font-mono text-xs">{row.model}{row.kind !== "turn" && <span className="ml-2 font-sans text-muted-foreground">{row.kind}</span>}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.responses)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.input)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.cacheRead)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.output)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatCost(row.cost)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </>
  );
}
