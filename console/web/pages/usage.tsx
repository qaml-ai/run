import { useState } from "react";
import { BarChart3 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorAlert, PageHeader, Stats } from "@/components/common";
import { formatCost, formatNumber, useApi, type Usage } from "@/lib/api";

export function UsagePage() {
  const [days, setDays] = useState("30");
  const usage = useApi<Usage>(`/v1/usage?days=${days}`);
  const totals = usage.data?.totals;
  return (
    <>
      <PageHeader title="Usage" description="Model responses from your agents. Costs are estimates from list prices; responses on the platform's keys are paid from your credit (see Billing)."
        actions={
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last 24 hours</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        } />
      <ErrorAlert error={usage.error} />
      {!usage.data ? <Skeleton className="h-64 w-full" /> : (
        <>
          <Stats items={[
            { label: "Responses", value: formatNumber(totals!.responses) },
            { label: "Input tokens", value: formatNumber(totals!.input + totals!.cacheRead + totals!.cacheWrite) },
            { label: "Output tokens", value: formatNumber(totals!.output) },
            { label: "Estimated cost", value: formatCost(totals!.cost) },
          ]} />
          {usage.data.days.length === 0 ? <EmptyState icon={<BarChart3 />} title="No usage in this period" /> : (
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
                      <TableCell className="font-mono text-xs">{row.model}{row.kind === "compaction" && <span className="ml-2 font-sans text-muted-foreground">compaction</span>}</TableCell>
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
