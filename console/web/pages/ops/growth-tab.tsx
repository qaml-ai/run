import { CloudOff, PlugZap } from "lucide-react";
import type { AdminAcquisition } from "../../../../src/admin-acquisition";
import type { AdminGrowth } from "../../../../src/admin-growth";
import { count, day, fullDay, percent, plural, useOps, type OpsRange } from "@/lib/ops";
import { CohortGrid, ColumnChart, dayColumn, FOCUS, Funnel, HBars, INK, MID, SplitBar, type PanelState } from "./charts";
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
          <Panel title="Sign-ups per day" state={growth.state}>
            {data && <SignupsChart data={data} />}
          </Panel>
          <Panel title="Accounts doing work, per day" hint="Accounts whose agents got at least one model answer that day (web searches, voice or images alone do not count). Returning accounts were made before that day; new ones that same day." state={growth.state}>
            {data && <WorkChart data={data} />}
          </Panel>
        </div>
      </Section>

      <Section title="Where sign-ups came from" description="The journey store’s first source, with a plugin label when the first OAuth grant was within one hour of sign-up.">
        <Panel title="Sources" state={acquisition.state} description={acquisition.data && <AcquisitionNote data={acquisition.data} days={days} signups={data?.tiles.signups.current} />}>
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

function SignupsChart({ data }: { data: AdminGrowth }) {
  const total = data.tiles.signups.current;
  const days = data.daily.length;
  return (
    <>
      <p className="text-muted-foreground mb-3 text-xs"><span className="text-foreground font-mono">{count(total)}</span> in {days} days, {count(Math.round(total / days * 10) / 10)} a day on average</p>
      <ColumnChart label={`Sign-ups per day: ${count(total)} in ${days} days`}
        series={[{ key: "signups", label: "sign-ups", color: FOCUS }]}
        data={data.daily.map(row => ({
          ...dayColumn(row.date, data.range.incomplete_date), values: [row.signups],
          more: METHODS.map(method => ({ value: count(row[method.key]), label: `with ${method.label}` })),
        }))}
        table={{ columns: ["Day (UTC)", "Sign-ups", ...METHODS.map(method => method.label)], rows: [...data.daily].reverse().map(row => [dayColumn(row.date, data.range.incomplete_date).title, row.signups, ...METHODS.map(method => row[method.key])]) }} />
      <div className="mt-4 border-t pt-3.5">
        <p className="text-muted-foreground mb-2 text-xs">How they signed in</p>
        <SplitBar inline unit="sign-ups" label="How they signed in" parts={METHODS.map(method => ({ key: method.key, label: method.label, value: data.sign_in[method.key], color: method.color }))} />
      </div>
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
function AcquisitionNote({ data, days, signups }: { data: AdminAcquisition; days: number; signups?: number }) {
  if (data.status !== "ok") return null;
  const parts = [
    `${plural(data.tracked_signups, "sign-up")} tracked${signups !== undefined ? ` of ${count(signups)}` : ""} in ${days} days`,
    data.coverage.first_event_at ? `records begin ${fullDay(data.coverage.first_event_at)}` : undefined,
    data.truncated ? "counted from the first accounts the store returned, so these are a sample" : undefined,
  ].filter(Boolean);
  return <>{parts.join(" · ")}</>;
}

function Acquisition({ data, days }: { data: AdminAcquisition; days: number }) {
  if (data.status === "not_configured") {
    return (
      <Empty icon={<PlugZap />} className="min-h-40">
        Where people come from is kept by the journey store, which this server is not connected to. The runtime sends each sign-up&rsquo;s referrer, link tags (UTM) and
        entry channel there once <code className="font-mono">AGENT_JOURNEY_URL</code> and <code className="font-mono">AGENT_JOURNEY_REPORT_SECRET</code> are set.
      </Empty>
    );
  }
  if (data.status === "unavailable") return <Empty icon={<CloudOff />} className="min-h-40">The journey store did not answer just now. Refresh to ask again.</Empty>;
  if (!data.tracked_signups) {
    return <Empty className="min-h-40">The journey store has no sign-ups from the last {days} days yet. A sign-up shows here once its browser agreed to be measured.</Empty>;
  }
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
    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <HBars label="Sign-ups by where they came from" unit="sign-ups" columns={["Sign-ups", "Activated", "Paying"]}
          items={data.sources.map(source => ({
            key: `${source.source}\n${source.medium ?? ""}`, text: source.medium ? `${source.source} (${source.medium})` : source.source,
            label: source.source, sub: source.medium ?? undefined, value: source.signups,
            extra: [{ value: count(source.activated), label: "activated" }, { value: count(source.paying), label: "paying" }],
          }))} />
        <TableView columns={["Source", "Medium", "Sign-ups", "Activated", "Paying"]}
          rows={data.sources.map(source => [source.source, source.medium ?? "—", source.signups, source.activated, source.paying])} />
      </div>
      <div className="grid content-start gap-6">
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
