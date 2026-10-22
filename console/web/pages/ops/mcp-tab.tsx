import type { AdminMcp } from "../../../../src/admin-mcp";
import { count, useOps, type OpsRange } from "@/lib/ops";
import { DataTable, Panel, Section } from "./parts";

const LABELS = { chatgpt: "ChatGPT", codex: "Codex", claude: "Claude", other: "Other MCP" };

export function McpTab({ days, refresh }: { days: OpsRange; refresh: number }) {
  const report = useOps<AdminMcp>(`/api/mcp?days=${days}`, refresh);
  const data = report.data;
  return <Section title="MCP plugins" description="Self-serve accounts, excluding staff and deleted accounts. Dates are UTC; today is incomplete.">
    <Panel title="From authorization to returning use" state={report.state} description="Accounts signed up in the selected window. Progress is account-wide and can include work outside the plugin.">
      {data && <DataTable rows={data.funnel} rowKey={row => row.kind} columns={[
        { key: "kind", label: "Plugin", cell: row => row.label },
        { key: "authorized", label: "Authorized", cell: row => count(row.authorized) },
        { key: "agent", label: "Created an agent", cell: row => count(row.made_agent) },
        { key: "turn", label: "Ran a turn", cell: row => count(row.ran_turn) },
        { key: "return", label: "Returned later", cell: row => count(row.came_back) },
      ]} />}
    </Panel>
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <Panel title="Sign-ups per day" state={report.state} description="First retained OAuth grant within one hour of sign-up. Each account has one acquisition kind.">
        {data && <DataTable rows={data.daily.filter(row => row.signups > 0)} rowKey={row => `${row.date}/${row.kind}`} columns={[
          { key: "day", label: "UTC date", cell: row => row.date },
          { key: "kind", label: "Plugin", cell: row => LABELS[row.kind] },
          { key: "signups", label: "Sign-ups", cell: row => count(row.signups) },
        ]} />}
      </Panel>
      <Panel title="Weekly accounts with token activity" state={report.state} description="Latest token issuance or refresh per grant. This is not a count of accounts making MCP requests. Weeks are clipped to the selected range.">
        {data && <DataTable rows={data.weekly} rowKey={row => `${row.week}/${row.kind}`} columns={[
          { key: "week", label: "Week of (UTC)", cell: row => row.week },
          { key: "kind", label: "Plugin", cell: row => LABELS[row.kind] },
          { key: "active", label: "Accounts", cell: row => count(row.token_active_accounts) },
        ]} />}
      </Panel>
    </div>
    <div className="mt-4">
      <Panel title="Daily accounts with token activity" state={report.state}>
        {data && <DataTable rows={data.daily.filter(row => row.token_active_accounts > 0)} rowKey={row => `${row.date}/${row.kind}`} columns={[
          { key: "day", label: "UTC date", cell: row => row.date },
          { key: "kind", label: "Plugin", cell: row => LABELS[row.kind] },
          { key: "active", label: "Accounts", cell: row => count(row.token_active_accounts) },
        ]} />}
      </Panel>
    </div>
    {data && <div className="text-muted-foreground mt-5 space-y-2 text-xs" aria-label="Metric limitations">
      {data.limitations.map(note => <p key={note}>{note}</p>)}
    </div>}
  </Section>;
}
