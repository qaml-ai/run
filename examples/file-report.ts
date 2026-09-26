import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import assert from "node:assert/strict";
import { AgentRuntime } from "../clients/node.ts";

// An app hands an agent a CSV, a PDF and an image, and gets back a report and a chart.
// It exercises the file layer end to end: attachments, native image and PDF input, `fs` in
// js_exec, present_file, the run's file lists, downloads and signed links.
//
//   AGENT_URL=https://agents.camelai.dev AGENT_RUNTIME_TOKEN=… node --experimental-strip-types examples/file-report.ts [--keep]

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

const runtime = new AgentRuntime({ url: process.env.AGENT_URL, apiKey: process.env.AGENT_RUNTIME_TOKEN });
const agent = await runtime.createAgent({
  name: "File report example",
  model: process.env.AGENT_MODEL ?? "anthropic/claude-sonnet-5",
  systemPrompt: "You are an analyst. Do arithmetic in js_exec with fs, never in your head. Keep replies short.",
  onEvent(event) {
    if (event.type === "file_presented") console.log(`presented ${event.file.path} (${event.file.contentType}, ${event.file.size} B): ${event.url.slice(0, 60)}…`);
    if (event.type === "tool_execution_start") console.log(`tool ${event.toolName}`);
  },
});
try {
  const result = await agent.prompt(
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
  console.log(`\nreply: ${result.reply}\n`);
  console.log("wrote:", result.files.map((file: { path: string; size: number }) => `${file.path} (${file.size} B)`).join(", "));

  // What the agent handed over, downloaded into ./out, plus a link to share one of them.
  await mkdir("out", { recursive: true });
  const presented: string[] = result.presented.map((file: { path: string }) => file.path);
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
  if (process.argv.includes("--keep")) console.log(`kept agent ${agent.session.id}`);
  else await agent.destroy();
}

/** A solid-colour PNG. */
function png(width: number, height: number, rgb: number[]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Uint8Array) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.from([0, ...Array.from({ length: width }, () => rgb).flat()])));
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]));
}

/** A one-page PDF with a line of Helvetica text. */
function pdf(text: string) {
  const stream = `BT /F1 16 Tf 50 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => { const at = out.length; out += `${index + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(at => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
