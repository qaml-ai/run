import { schema } from "@camelai/run";
import { Value } from "typebox/value";
import type { Static } from "typebox";
import type { Problem, Validate } from "../lib/projects.ts";
import type { Files } from "../lib/versions.ts";
import type { QueryResult, SampleDb } from "./db.ts";

const Chart = schema.Object({
  title: schema.String({ minLength: 1, maxLength: 80 }),
  type: schema.Union([schema.Literal("bar"), schema.Literal("line"), schema.Literal("table"), schema.Literal("number")]),
  /** A file next to dashboard.json: queries/<name>.sql. */
  query: schema.String({ pattern: "^queries/[A-Za-z0-9_-]+\\.sql$" }),
  /** bar, line: the column along the x axis. */
  x: schema.Optional(schema.String()),
  /** bar, line: the columns plotted (numbers); number: the one column shown, from the first row. */
  y: schema.Optional(schema.Array(schema.String(), { minItems: 1, maxItems: 4 })),
}, { additionalProperties: false });

export const Dashboard = schema.Object({
  title: schema.String({ minLength: 1, maxLength: 100 }),
  charts: schema.Array(Chart, { minItems: 1, maxItems: 12 }),
}, { additionalProperties: false });
export type Dashboard = Static<typeof Dashboard>;

/**
 * A dashboard can be published when dashboard.json fits the schema and every chart's query runs against the sample
 * data and returns the columns the chart names. The version keeps dashboard.json and the queries it uses.
 */
export function dashboardValidator(db: SampleDb): Validate {
  return async files => {
    const text = files.get("dashboard.json");
    if (!text) return { problems: [{ path: "dashboard.json", message: "Missing: the dashboard's spec" }] };
    let spec: unknown;
    try { spec = JSON.parse(new TextDecoder().decode(text)); } catch (error) {
      return { problems: [{ path: "dashboard.json", message: `Not JSON: ${(error as Error).message}` }] };
    }
    if (!Value.Check(Dashboard, spec)) return { problems: schemaProblems(spec) };
    const problems: Problem[] = [];
    const kept: Files = new Map([["dashboard.json", text]]);
    for (const [index, chart] of spec.charts.entries()) {
      const where = `dashboard.json: charts[${index}] "${chart.title}"`;
      const sql = files.get(chart.query);
      if (!sql) { problems.push({ path: chart.query, message: `Missing: ${where} uses it` }); continue; }
      kept.set(chart.query, sql);
      let result: QueryResult;
      try { result = await db.query(new TextDecoder().decode(sql)); } catch (error) {
        problems.push({ path: chart.query, message: (error as Error).message });
        continue;
      }
      problems.push(...chartProblems(chart, result).map(message => ({ path: chart.query, message: `${where}: ${message}` })));
    }
    return { problems, files: kept };
  };
}

/** What stops a chart from drawing this query's result. */
export function chartProblems(chart: Dashboard["charts"][number], { columns, rows }: QueryResult): string[] {
  const missing = [chart.x, ...chart.y ?? []].filter(column => column !== undefined && !columns.includes(column));
  if (missing.length) return [`the query returns no column ${missing.join(", ")} (it returns ${columns.join(", ")})`];
  if (chart.type === "bar" || chart.type === "line") {
    if (!chart.x || !chart.y) return [`a ${chart.type} chart needs x and y`];
    const text = chart.y.filter(column => rows.some(row => row[columns.indexOf(column)] !== null && typeof row[columns.indexOf(column)] !== "number"));
    if (text.length) return [`y column ${text.join(", ")} must be numbers`];
  }
  if (chart.type === "number") {
    if (chart.y?.length !== 1) return ["a number chart needs y: one column"];
    if (rows.length === 0) return ["the query returns no rows, so there is no number to show"];
  }
  return [];
}

/** The schema's complaints, one per field. */
function schemaProblems(spec: unknown): Problem[] {
  const byPath = new Map<string, string>();
  const allowed = new Map<string, unknown[]>();
  for (const error of Value.Errors(Dashboard, spec)) {
    const field = error.instancePath || "/";
    // A union of literals fails once per literal, then as a whole: say which values it takes.
    if (error.keyword === "const") allowed.set(field, [...allowed.get(field) ?? [], (error.params as { allowedValue: unknown }).allowedValue]);
    byPath.set(field, error.keyword === "anyOf" && allowed.has(field) ? `must be one of ${allowed.get(field)!.join(", ")}` : error.message);
  }
  return [...byPath].slice(0, 20).map(([field, message]) => ({ path: "dashboard.json", message: `${field}: ${message}` }));
}
