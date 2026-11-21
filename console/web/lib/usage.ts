import type { UsageDay, UsageResponse } from "@/lib/api";

/** A UTC day (YYYY-MM-DD), `back` days before `now`'s: usage is kept by UTC day. */
export const utcDay = (now: number, back = 0) => new Date(now - back * 86_400_000).toISOString().slice(0, 10);

export type UsageTotals = { responses: number; input: number; output: number; cost: number };
const zero = (): UsageTotals => ({ responses: 0, input: 0, output: 0, cost: 0 });
const KEYS = ["responses", "input", "output", "cost"] as const;
const add = (into: UsageTotals, row: UsageTotals) => {
  for (const key of KEYS) into[key] += row[key];
};

/**
 * The last `range` UTC days of a usage read that covers at least twice as many, against the `range` days before:
 * totals, each day's spend (oldest first, zero for a day without any), spend by model, and the day × model rows.
 */
export function summarizeUsage(usage: UsageResponse, range: number, now = Date.now()) {
  const first = utcDay(now, range - 1);
  const priorFirst = utcDay(now, 2 * range - 1);
  const today = utcDay(now);
  const days = Array.from({ length: range }, (_, at) => utcDay(now, range - 1 - at));
  const index = new Map(days.map((day, at) => [day, at]));
  const daily = days.map(() => 0);
  const totals = zero();
  const models = new Map<string, UsageTotals & { model: string }>();
  let prior = 0;
  let responsesToday = 0;

  const rows: UsageDay[] = (usage.days ?? []).filter(row => {
    if (row.day === today) responsesToday += row.responses;
    if (row.day < first) {
      if (row.day >= priorFirst) prior += row.cost;
      return false;
    }
    return true;
  });

  for (const row of rows) {
    add(totals, row);
    daily[index.get(row.day) ?? daily.length - 1] += row.cost;
    const label = row.kind === "turn" || !row.kind ? row.model : `${row.kind} · ${row.model}`;
    const model = models.get(label) ?? { model: label, ...zero() };
    add(model, row);
    models.set(label, model);
  }

  return {
    totals,
    prior,
    responsesToday,
    days,
    daily: days.map((day, at) => ({ day, cost: daily[at] })),
    models: [...models.values()]
      .filter(row => row.cost > 0 || row.responses > 0)
      .sort((a, b) => b.cost - a.cost),
    rows: [...rows].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.cost - a.cost)),
  };
}

/** "↑ 12% vs prior 30 days", or what there is to say without a prior period's spend. */
export function changeLabel(spend: number, prior: number, range: number) {
  const period = range === 1 ? "the day before" : `prior ${range} days`;
  if (prior <= 0) return spend > 0 ? `no spend the ${range === 1 ? "day" : `${range} days`} before` : undefined;
  const percent = Math.round(((spend - prior) / prior) * 100);
  return `${percent > 0 ? "↑" : percent < 0 ? "↓" : "±"} ${Math.abs(percent)}% vs ${period}`;
}
