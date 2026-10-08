import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { Agents } from "@camelai/run";
import { BASE_URL, DATA_DIR, PUBLIC_URL, html, page, start } from "../lib/app.ts";
import { Projects } from "../lib/projects.ts";
import { Versions } from "../lib/versions.ts";
import { SampleDb, type QueryResult } from "./db.ts";
import { dashboardValidator, type Dashboard } from "./validate.ts";

const db = new SampleDb();
const versions = new Versions(join(DATA_DIR, "dashboards"));
const projects = new Projects({
  agents: new Agents(),
  kind: "dashboard",
  dataDir: DATA_DIR,
  versions,
  validate: dashboardValidator(db),
  url: (project, version) => `${BASE_URL}/dashboards/${project}/v/${version}`,
  publicUrl: PUBLIC_URL,
  agent: {
    ...(process.env.AGENT_MODEL ? { model: process.env.AGENT_MODEL } : {}),
    instructions: `You build a dashboard with the user, over a shop's 2025 sales in SQLite. Its tables:
${readFileSync(new URL("./sample.sql", import.meta.url), "utf8").match(/CREATE TABLE[^;]+;/g)!.join("\n")}

The dashboard is two kinds of files under /dashboard:
- queries/<name>.sql: one SQLite SELECT each, at most 1,000 rows.
- dashboard.json: {"title": string, "charts": [{"title", "type": "bar" | "line" | "table" | "number", "query": "queries/<name>.sql", "x"?: column, "y"?: [columns]}]}.
  bar and line need x and y (y: numeric columns); number shows y's one column from the first row; table shows every column.
You can't run queries yourself: write the files, then call publish, which runs every query. It either publishes a new
version and gives you its address, which you share, or lists problems: fix every one and publish again. Edit files in
place when asked for changes. Never claim a version is live unless publish said so.`,
  },
});

const app = new Hono();

app.get("/", c => c.redirect(`/dashboards/${PROJECT}`));
app.get("/dashboards/:project", async c => {
  const latest = (await versions.list(c.req.param("project"))).at(-1);
  return latest ? c.redirect(`/dashboards/${latest.project}/v/${latest.number}`)
    : c.html(page("No dashboard yet", `<h1>${html(c.req.param("project"))}</h1><p class="muted">Nothing published yet: ask the agent for a dashboard.</p>`));
});

// A published version, drawn from its spec and queries, run now against the data (read-only).
app.get("/dashboards/:project/v/:version", async c => {
  const { project, version } = c.req.param();
  const all = await versions.list(project);
  const text = async (path: string) => new TextDecoder().decode((await versions.file(project, Number(version), path))!);
  if (!all.some(v => v.number === Number(version))) return c.text("Not found", 404);
  const spec: Dashboard = JSON.parse(await text("dashboard.json"));
  const charts = await Promise.all(spec.charts.map(async chart => ({
    ...chart, result: await db.query(await text(chart.query)).catch((error: Error) => ({ error: error.message })),
  })));
  const nav = all.map(v => v.number === Number(version) ? `<b>v${v.number}</b>` : `<a href="/dashboards/${project}/v/${v.number}">v${v.number}</a>`).join(" · ");
  return c.html(page(spec.title, `<h1>${html(spec.title)}</h1><p class="muted">${nav}</p>
    <div class="grid">${charts.map((chart, index) => `<section><h2>${html(chart.title)}</h2>${draw(chart, index)}</section>`).join("")}</div>
    <script>const charts = ${JSON.stringify(charts).replace(/</g, "\\u003c")};</script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
    <script>
      charts.forEach((chart, index) => {
        if (chart.type !== "bar" && chart.type !== "line" || chart.result.error) return;
        const { columns, rows } = chart.result, at = name => columns.indexOf(name);
        new Chart(document.getElementById("chart-" + index), {
          type: chart.type,
          data: { labels: rows.map(row => row[at(chart.x)]), datasets: chart.y.map(y => ({ label: y, data: rows.map(row => row[at(y)]) })) },
          options: { plugins: { legend: { display: chart.y.length > 1 } } },
        });
      });
    </script>`, `<style>
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 16px; }
      section { border: 1px solid #d2d2d7; border-radius: 8px; padding: 16px; overflow: auto; max-height: 420px; }
      h2 { font-size: 15px; margin: 0 0 12px; } .number { font-size: 40px; font-weight: 600; }
    </style>`));
});

/** The parts drawn on the server: tables, numbers and errors. Bar and line charts get a canvas for Chart.js. */
function draw(chart: Dashboard["charts"][number] & { result: QueryResult | { error: string } }, index: number) {
  if ("error" in chart.result) return `<p class="muted">This query fails now: ${html(chart.result.error)}</p>`;
  const { columns, rows } = chart.result;
  if (chart.type === "number") return `<div class="number">${html(Number(rows[0]?.[columns.indexOf(chart.y![0])]).toLocaleString())}</div>`;
  if (chart.type === "table") {
    return `<table><tr>${columns.map(column => `<th>${html(column)}</th>`).join("")}</tr>${
      rows.map(row => `<tr>${row.map(cell => `<td>${html(cell ?? "")}</td>`).join("")}</tr>`).join("")}</table>`;
  }
  return `<canvas id="chart-${index}"></canvas>`;
}

const PROJECT = process.argv[2] ?? "demo";
await start(app, projects, PROJECT);
