import type { AdminAcquisition, AdminSource } from "../../../../src/admin-acquisition";
import type { AdminGrowth } from "../../../../src/admin-growth";
import { count, day, fullDay, percent, plural, useOps, type OpsRange } from "@/lib/ops";
import { CohortGrid, ColumnChart, dayColumn, FOCUS, Funnel, INK, MID, ORDINAL, SplitBar, type PanelState } from "./charts";
import { Empty, Panel, Ready, Section, Stat, Stats, TableView } from "./parts";

/** Growth: are we growing, do people stay, and where do they come from? Self-serve accounts only, not the team's. */
export function GrowthTab({ days, refresh, growth }: { days: OpsRange; refresh: number; growth: { data?: AdminGrowth; state: PanelState } }) {
  const acquisition = useOps<AdminAcquisition>(`/api/acquisition?days=${days}`, refresh);
  const data = growth.data;
  const before = `vs the ${days} days before`;
  return (
    <>
      <div className="mb-10">
        <Ready state={growth.state}>
          {data && (
            <Stats>
              <Stat label="Sign-ups" value={count(data.tiles.signups.current)} compare={data.tiles.signups} compareLabel={before}
                hint={<>Accounts people made for themselves in the last {days} UTC days, today so far included. The team&rsquo;s own and erased accounts are left out everywhere here.</>} />
              <Stat label="Activated" value={count(data.tiles.activated.current)} detail={`${percent(data.tiles.activated.current, data.tiles.signups.current)} of them ran a model`}
                hint="Of those sign-ups, the ones whose agents have had a model answer by now." />
              <Stat label="Weekly active accounts" value={count(data.tiles.weekly_active.current)} compare={data.tiles.weekly_active} compareLabel="vs the 7 days before"
                hint="Accounts whose agents got at least one model answer in the last 7 whole UTC days (yesterday back), whoever started the run: a person, a schedule or a channel. Web searches, voice or images alone do not count, and neither does opening the console." />
              <Stat label="Came back this week" value={count(data.tiles.weekly_returning.current)} compare={data.tiles.weekly_returning} compareLabel="vs the 7 days before"
                hint="Of the weekly active accounts, the ones made before those 7 days: people who came back." />
            </Stats>
          )}
        </Ready>
      </div>

      <Section title="Sign-ups and work, day by day" description="By UTC day. Today is still going, so its column is fainter.">
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Sign-ups, by where they came from" state={acquisition.state} hint="Sales-site visitors are grouped by their first landing page; other visitors by their original referral. Small sources are grouped as Other; hover a day for the breakdown. Not captured means the source is unknown, not direct traffic.">
            {acquisition.data && <SignupsChart data={acquisition.data} growth={data} />}
          </Panel>
          <Panel title="Accounts doing work, per day" hint="Accounts whose agents got at least one model answer that day (web searches, voice or images alone do not count). Returning accounts were made before that day; new ones that same day." state={growth.state}>
            {data && <WorkChart data={data} />}
          </Panel>
        </div>
      </Section>

      <Section title="Where sign-ups came from" description={`Outside people who signed up in the last ${days} days, by where they came from and what they have done since. Sales-site visits are split by their first landing page. A plugin is the source when their first connection was within an hour of signup.`}>
        <Panel title="Sources" state={acquisition.state} description={acquisition.data && <AcquisitionNote data={acquisition.data} days={days} />}>
          {acquisition.data && <Acquisition data={acquisition.data} days={days} />}
        </Panel>
      </Section>

      <Section title="From sign-up to a working agent" description={`Accounts that signed up in the last ${days} days, and how far each has got by now.`}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Panel title="Where sign-ups stop" hint="Each step counts the accounts that reached it: made an agent (or ran one), got a model answer, and got one again on a later day than they signed up." state={growth.state}>
            {data && <SignupFunnel data={data} days={days} />}
          </Panel>
          <Panel title="Time to a first run" state={growth.state}>
            {data && <FirstRun data={data} days={days} />}
          </Panel>
        </div>
      </Section>

      <Section title="Do people come back?" description="Each row is a week of sign-ups (weeks start on Monday, UTC). Each cell is the share of them whose agents did work that many weeks later.">
        <Panel title="Weekly sign-ups, and who kept working" state={growth.state}>
          {data && (data.cohorts.some(cohort => cohort.size)
            ? <CohortGrid cohorts={data.cohorts} />
            : <Empty>No sign-ups in the last 12 weeks yet. Each week&rsquo;s sign-ups get a row here, and a new column every 7 days.</Empty>)}
        </Panel>
      </Section>
    </>
  );
}

const METHODS = [
  { key: "github", label: "GitHub", color: FOCUS },
  { key: "google", label: "Google", color: INK },
  { key: "email", label: "Email", color: MID },
] as const;

const sourceName = (row: AdminSource) => {
  const source = row.source.replace(/^(?:www\.)?camelai\.com(?=\/)/i, "");
  return row.medium ? `${source} (${row.medium})` : source;
};

function SignupsChart({ data, growth }: { data: AdminAcquisition; growth?: AdminGrowth }) {
  // Keep plugin acquisition and unknown coverage visible even when their counts are small.
  const fixed = data.sources.map((row, index) => /plugin$/.test(row.source) || row.source === "Not captured" ? index : -1).filter(index => index >= 0);
  const kept = new Set([...fixed, ...data.sources.map((_, index) => index).filter(index => !fixed.includes(index)).slice(0, Math.max(1, 5 - fixed.length))]);
  const folded = data.sources.map((_, index) => index).filter(index => !kept.has(index));
  const groups = [...kept].sort((a, b) => a - b).map(index => ({ label: sourceName(data.sources[index]), indices: [index] }));
  if (folded.length) groups.push({ label: "Other", indices: folded });
  return (
    <>
      <p className="text-muted-foreground mb-3 text-xs"><span className="text-foreground font-mono">{count(data.total.signups)}</span> in {data.range.days} days</p>
      <ColumnChart totalFirst label={`Sign-ups by source: ${count(data.total.signups)} in ${data.range.days} days`}
        series={groups.map((group, index) => ({ key: String(index), label: group.label, color: group.label === "Other" ? INK : group.label === "Not captured" ? MID : ORDINAL[index % ORDINAL.length] }))}
        data={data.daily.map(row => ({
          ...dayColumn(row.date, data.range.incomplete_date), values: groups.map(group => group.indices.reduce((sum, index) => sum + row.counts[index], 0)),
          more: [...folded].filter(index => row.counts[index]).sort((a, b) => row.counts[b] - row.counts[a] || sourceName(data.sources[a]).localeCompare(sourceName(data.sources[b]))).map(index => ({ value: count(row.counts[index]), label: sourceName(data.sources[index]), muted: true })),
        }))}
        table={{ columns: ["Day (UTC)", "Sign-ups", ...data.sources.map(sourceName)], rows: [...data.daily].reverse().map(row => [dayColumn(row.date, data.range.incomplete_date).title, row.counts.reduce((a, b) => a + b, 0), ...row.counts]) }} />
      <Coverage data={data} />
      {growth && <div className="mt-4 border-t pt-3.5">
        <p className="text-muted-foreground mb-2 text-xs">How they signed in</p>
        <SplitBar inline unit="sign-ups" label="How they signed in" parts={METHODS.map(method => ({ key: method.key, label: method.label, value: growth.sign_in[method.key], color: method.color }))} />
      </div>}
    </>
  );
}

function WorkChart({ data }: { data: AdminGrowth }) {
  const full = data.daily.filter(row => row.date !== data.range.incomplete_date);
  const sum = (rows: typeof full, key: "active_new" | "active_returning") => rows.reduce((total, row) => total + row[key], 0);
  const returning = sum(full, "active_returning"), fresh = sum(full, "active_new");
  const busiest = [...data.daily].sort((a, b) => b.active_new + b.active_returning - a.active_new - a.active_returning)[0];
  const average = full.length ? (returning + fresh) / full.length : 0;
  return (
    <>
      <ColumnChart label="Accounts doing work per day, returning and new"
        series={[{ key: "returning", label: "Returning", color: FOCUS }, { key: "new", label: "New that day", color: MID }]}
        data={data.daily.map(row => ({ ...dayColumn(row.date, data.range.incomplete_date), values: [row.active_returning, row.active_new] }))} />
      <dl className="mt-4 grid grid-cols-3 gap-3 border-t pt-3.5 text-xs">
        <div><dt className="text-muted-foreground">A day on average</dt><dd className="mt-0.5 text-base font-semibold">{count(Math.round(average * 10) / 10)}</dd></div>
        <div><dt className="text-muted-foreground">Of them returning</dt><dd className="mt-0.5 text-base font-semibold">{percent(returning, returning + fresh)}</dd></div>
        <div><dt className="text-muted-foreground">Busiest day</dt><dd className="mt-0.5 text-base font-semibold">{busiest && busiest.active_new + busiest.active_returning ? <>{count(busiest.active_new + busiest.active_returning)} <span className="text-muted-foreground text-xs font-normal">{day(busiest.date)}</span></> : "—"}</dd></div>
      </dl>
    </>
  );
}

/** Under the Sources title: how much of the window the store saw. */
function AcquisitionNote({ data, days }: { data: AdminAcquisition; days: number }) {
  const known = data.total.signups - data.sources.filter(row => row.source === "Not captured").reduce((sum, row) => sum + row.signups, 0);
  const parts = [
    `${count(known)} of ${plural(data.total.signups, "sign-up")} have a recorded source in ${days} days`,
    data.coverage.first_event_at ? `records begin ${fullDay(data.coverage.first_event_at)}` : undefined,
    data.truncated ? "source lookup is incomplete; unread sources are marked Not captured" : undefined,
  ].filter(Boolean);
  return <>{parts.join(" · ")}</>;
}

function Coverage({ data }: { data: AdminAcquisition }) {
  return <p className="text-muted-foreground mt-3 text-xs">
    {data.status === "not_configured" ? "Source reporting is not connected. Signup and usage counts still include all outside accounts. " : data.status === "unavailable" ? "Source reporting is temporarily unavailable. Signup and usage counts still include all outside accounts. " : ""}
    {data.truncated ? "Some source records could not be read. " : ""}
    Not captured includes unmeasured visits, older signups and source records not yet received. Direct means a recorded visit without a known referral or campaign.
  </p>;
}

function Acquisition({ data, days }: { data: AdminAcquisition; days: number }) {
  if (!data.total.signups) return <><Empty>No outside sign-ups in the last {days} days.</Empty><Coverage data={data} /></>;
  const list = (title: string, rows: { key: string; value: number }[], none: string) => (
    <div>
      <h4 className="text-muted-foreground mb-1.5 text-xs">{title}</h4>
      {rows.length ? (
        <ul className="grid text-xs">
          {rows.map(row => (
            <li key={row.key} className="flex items-baseline justify-between gap-3 border-b py-1 last:border-b-0">
              <span className="min-w-0 truncate" title={row.key}>{row.key}</span>
              <span className="font-mono tabular-nums">{count(row.value)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-muted-foreground text-xs">{none}</p>}
    </div>
  );
  return (
    <div className="grid gap-x-8 gap-y-6">
      <div className="min-w-0">
        <p className="text-muted-foreground mb-3 text-xs">Usage is counted through today. Active 2+ days means model answers on at least two UTC days, including scheduled and channel runs. Typical wait is the median number of UTC days to a first model answer, among those who ran one. Newer signups have had less time to return or pay.</p>
        <div className="overflow-x-auto">
          <table aria-label={`Sign-ups of the last ${days} days by source`} className="w-full text-left text-sm tabular-nums">
            <thead><tr>{["Source", "Sign-ups", "Share", "Made an agent", "Ran a model", "Typical wait to first run", "Active 2+ days", "Paid"].map(label => <th key={label} className="text-muted-foreground whitespace-nowrap px-3 py-2 text-xs font-medium">{label}</th>)}</tr></thead>
            <tbody>{[...data.sources, data.total].map((row, index) => <tr key={index} className={`border-t ${index === data.sources.length ? "font-semibold" : ""}`}>
              <td className="whitespace-nowrap px-3 py-2">{sourceName(row)}</td>
              <td className="px-3 py-2">{count(row.signups)}</td>
              <td className="px-3 py-2">{percent(row.signups, data.total.signups)}</td>
              {[row.made_agent, row.activated].map((value, i) => <td key={i} className="whitespace-nowrap px-3 py-2">{count(value)} ({percent(value, row.signups)})</td>)}
              <td className="whitespace-nowrap px-3 py-2">{row.median_days_to_first_run === null ? "—" : row.median_days_to_first_run === 0 ? "Same day" : plural(row.median_days_to_first_run, "day")}</td>
              {[row.active_two_days, row.paying].map((value, i) => <td key={i} className="whitespace-nowrap px-3 py-2">{count(value)} ({percent(value, row.signups)})</td>)}
            </tr>)}</tbody>
          </table>
        </div>
        <Coverage data={data} />
      </div>
      <div className="grid content-start gap-6 sm:grid-cols-2">
        {list("Campaigns", data.campaigns.map(row => ({ key: row.campaign, value: row.signups })), "No sign-up came with a campaign tag.")}
        {list("First page they landed on", data.landing_pages.map(row => ({ key: row.path, value: row.signups })), "No landing pages recorded.")}
      </div>
    </div>
  );
}

function SignupFunnel({ data, days }: { data: AdminGrowth; days: number }) {
  const labels = { signed_up: "Signed up", made_agent: "Made an agent", ran_model: "Ran a model", came_back: "Came back another day" } as const;
  const steps = (Object.keys(labels) as (keyof typeof labels)[]).map(key => ({ key, label: labels[key], value: data.funnel[key], previous: data.previous_funnel[key] }));
  if (!data.funnel.signed_up) return <Empty>No sign-ups in the last {days} days, so there is nobody to follow yet.</Empty>;
  return (
    <>
      <Funnel steps={steps} previousLabel={`in the ${days} days before`} />
      <TableView columns={["Step", `Last ${days} days`, "Share of the step before", `The ${days} days before`]}
        rows={steps.map((step, index) => [step.label, step.value, index ? percent(step.value, steps[index - 1].value) : "—", step.previous])} />
    </>
  );
}

function FirstRun({ data, days }: { data: AdminGrowth; days: number }) {
  const median = data.median_days_to_first_run;
  const ran = data.funnel.ran_model, before = data.previous_funnel;
  return (
    <dl className="grid gap-5">
      <Stat label="Typical wait for a first run" value={median === null ? "—" : median < 0.5 ? "Same day" : `${count(Math.round(median * 10) / 10)} ${median === 1 ? "day" : "days"}`}
        hint="The median: half of the sign-ups that ran a model did it this soon after signing up, or sooner."
        detail={median === null ? `Nobody who signed up in the last ${days} days has run a model yet` : `Half of the ${plural(ran, "account")} that ran a model did it this soon`} />
      <Stat label="Signed up and ran a model" value={percent(ran, data.funnel.signed_up)}
        detail={before.signed_up ? `${percent(before.ran_model, before.signed_up)} in the ${days} days before` : `Nobody signed up in the ${days} days before`} />
    </dl>
  );
}
