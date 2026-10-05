import { useState, type ReactNode } from "react";
import { Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorAlert, PageHeader, Stats } from "@/components/common";
import { formatCost, formatMicros, formatNumber, formatTime, useApi, type AdminStats } from "@/lib/api";

const percent = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : "—";

/** The platform operator's view of every tenant: sign-ups, how far they got, and usage. Shown only to billing admins (/v1/me `admin`). */
export function AdminPage() {
  const [days, setDays] = useState("14");
  const stats = useApi<AdminStats>(`/v1/admin/stats?days=${days}`, 60_000);
  const data = stats.data;
  return (
    <>
      <PageHeader title="Admin" description="Every tenant on this runtime. Sign-ups are self-serve accounts; days are UTC."
        actions={
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="14">Last 14 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        } />
      <ErrorAlert error={stats.error} />
      {!data ? <Skeleton className="h-64 w-full" /> : (
        <>
          <Stats items={[
            { label: "Sign-ups", value: formatNumber(data.signups.total), extra: <Sub>{data.signups.github} GitHub · {data.signups.google} Google · {data.signups.operator} operator{data.signups.deleted ? ` · ${data.signups.deleted} deleted` : ""}</Sub> },
            { label: "Last 24 hours", value: formatNumber(data.signups.last24h) },
            { label: "Last 7 days", value: formatNumber(data.signups.last7d) },
            { label: "Last 30 days", value: formatNumber(data.signups.last30d) },
          ]} />
          <Stats items={[
            { label: "Made a token", value: formatNumber(data.activation.withToken), extra: <Sub>{percent(data.activation.withToken, data.activation.tenants)} of live accounts</Sub> },
            { label: "Made an agent", value: formatNumber(data.activation.withAgent), extra: <Sub>{percent(data.activation.withAgent, data.activation.tenants)}</Sub> },
            { label: "Ran a model", value: formatNumber(data.activation.withUsage), extra: <Sub>{percent(data.activation.withUsage, data.activation.tenants)}</Sub> },
            { label: "Bought credit", value: formatNumber(data.activation.purchased), extra: <Sub>{formatMicros(data.purchases.amount)} in {data.purchases.count} purchases</Sub> },
          ]} />

          <h2 className="mb-3 text-sm font-medium">By day</h2>
          <div className="bg-card mb-8 border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead><TableHead className="text-right">Sign-ups</TableHead><TableHead className="text-right">Active tenants</TableHead>
                  <TableHead className="text-right">Responses</TableHead><TableHead className="text-right">Cost</TableHead><TableHead className="text-right">On platform keys</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...data.daily].reverse().map(row => (
                  <TableRow key={row.day}>
                    <TableCell className="tabular-nums">{row.day}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.signups)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.activeTenants)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.responses)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatCost(row.cost)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatCost(row.platformCost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <h2 className="mb-3 text-sm font-medium">Latest sign-ups <span className="text-muted-foreground font-normal">· {formatNumber(data.agents.live)} live agents across {formatNumber(data.agents.tenants)} tenants</span></h2>
          {data.recent.length === 0 ? <EmptyState icon={<Users />} title="No sign-ups yet" /> : (
            <div className="bg-card overflow-x-auto border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead><TableHead>Signed up</TableHead><TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right">Agents</TableHead><TableHead className="text-right">Responses</TableHead><TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Balance</TableHead><TableHead className="text-right">Bought</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recent.map(row => (
                    <TableRow key={row.tenant}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span>{row.github ?? row.googleEmail ?? row.tenant}</span>
                          {row.deleted ? <Badge variant="secondary">Deleted</Badge> : row.signIn && <span className="text-muted-foreground text-xs">{row.signIn}</span>}
                        </div>
                        {(row.github || row.googleEmail) && <div className="text-muted-foreground font-mono text-xs">{row.tenant}</div>}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap tabular-nums">{formatTime(row.createdAt)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.tokens)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.agents)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatNumber(row.responses)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatCost(row.cost)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatMicros(row.balance)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{row.purchased ? formatMicros(row.purchased) : "—"}</TableCell>
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

function Sub({ children }: { children: ReactNode }) {
  return <div className="text-muted-foreground mt-1 text-xs">{children}</div>;
}
