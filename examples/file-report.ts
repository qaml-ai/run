import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { Agents } from "../clients/node.ts";
import { pdf, png } from "./fixtures.ts";

// An app hands an agent a CSV, a PDF and an image, and gets back a report and a chart.
// It exercises the file layer end to end: attachments, native image and PDF input, `fs` in
// js_exec, present_file, the run's file lists, downloads and signed links.
//
//   CAMELAI_API_KEY=art_… node --experimental-strip-types examples/file-report.ts

const regions = ["North", "South", "East", "West"];
const rows = Array.from({ length: 48 }, (_, index) => ({
  month: `2026-${String(1 + (index % 12)).padStart(2, "0")}`,
  region: regions[Math.floor(index / 12)],
  revenue: 1000 + ((index * 7919) % 2500),
}));
const csv = ["month,region,revenue", ...rows.map(row => `${row.month},${row.region},${row.revenue}`)].join("\n");
const totals = Object.fromEntries(regions.map(region => [region, rows.filter(row => row.region === region).reduce((sum, row) => sum + row.revenue, 0)]));
const leader = Object.entries(totals).sort((a, b) => b[1] - a[1])[0][0];
const target = 30_000;

const agents = new Agents();
const agent = await agents.upsert("file-report", {
  name: "File report example",
  model: process.env.AGENT_MODEL ?? "anthropic/claude-sonnet-5-5",
  instructions: "You are an analyst. Do arithmetic in js_exec with fs, never in your head. Keep replies short.",
  onEvent(event) {
    if (event.type === "file_presented") console.log(`presented ${event.file.path} (${event.file.contentType}, ${event.file.size} B): ${event.url?.slice(0, 60)}…`);
    if (event.type === "tool_execution_start") console.log(`tool ${event.toolName}`);
  },
});
try {
  const run = await agent.run(
    "Attached are sales.csv, policy.pdf and logo.png. In js_exec, read the CSV with fs and total revenue per region. " +
    "Check each total against the annual target stated in the PDF. Tell me the logo's main colour. " +
    "Write /workspace/out/report.md (a table of totals, which regions meet the target, the colour) and " +
    "/workspace/out/chart.svg (a bar chart of the totals), then present both with present_file.",
    { files: [
      { name: "sales.csv", data: new TextEncoder().encode(csv), contentType: "text/csv" },
      { name: "policy.pdf", data: pdf(`Annual revenue target per region: ${target} USD.`), contentType: "application/pdf" },
      { name: "logo.png", data: png(48, 48, [30, 90, 220]), contentType: "image/png" },
    ] },
  );
  console.log(`\nreply: ${run.text}\n`);
  console.log("wrote:", run.files.map(file => `${file.path} (${file.size} B)`).join(", "));

  // What the agent handed over, downloaded into ./out, plus a link to share one of them.
  await mkdir("out", { recursive: true });
  const presented = (run.raw?.presented ?? []).map(file => file.path);
  for (const path of presented) {
    const { data, contentType } = await agent.files.download(path);
    await writeFile(`out/${path.split("/").pop()}`, data);
    console.log(`downloaded ${path} → out/ (${contentType}, ${data.byteLength} B)`);
  }
  const link = await agent.files.link("/workspace/out/report.md");
  console.log(`share link: ${link.url.slice(0, 70)}… (expires ${new Date(link.expiresAt).toISOString()})`);

  // Check the answers against what the app knows.
  const report = new TextDecoder().decode((await agent.files.download("/workspace/out/report.md")).data);
  const chart = new TextDecoder().decode((await agent.files.download("/workspace/out/chart.svg")).data);
  assert.ok(presented.includes("/workspace/out/report.md") && presented.includes("/workspace/out/chart.svg"), "both files presented");
  for (const [region, total] of Object.entries(totals)) {
    assert.ok(report.includes(String(total)) || report.includes(total.toLocaleString("en-US")), `report has ${region}'s total ${total}`);
  }
  assert.match(report, /blue/i, "report names the logo colour");
  assert.match(chart, /<svg/i, "chart is an SVG");
  assert.equal((await fetch(link.url)).status, 200, "the signed link downloads");
  console.log(`\nall checks passed (totals ${JSON.stringify(totals)}, leader ${leader}, target ${target})`);
} finally {
  // The agent stays, keyed "file-report": run this again to continue its conversation, or delete it.
  await agents.close();
}
