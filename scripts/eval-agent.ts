// Measures how directly an agent gets realistic work done: tool calls (by name), js_exec calls,
// model turns, tokens, cost, wall time and success, checked the way the examples check. Each run
// makes a fresh agent, so the numbers compare conditions (a runtime version, a model) fairly.
//
//   AGENT_URL=http://127.0.0.1:8790 AGENT_RUNTIME_TOKEN=… AGENT_MODEL=anthropic/claude-sonnet-5 \
//     node --experimental-strip-types scripts/eval-agent.ts [--runs 3] [--scenarios files,discovery,state,plain,list] [--label before]
//   node --experimental-strip-types scripts/eval-agent.ts --summary .agent-runtime/eval/before.jsonl .agent-runtime/eval/after.jsonl
//
// Each run appends a line to .agent-runtime/eval/<label>.jsonl, and its events (js_exec code included) to
// .agent-runtime/eval/<label>/<scenario>-<n>.jsonl, to read what the model did.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AgentRuntime, schema, tool, type Tools } from "../clients/node.ts";
import { pdf, png } from "../examples/fixtures.ts";

type Run = { agent: Awaited<ReturnType<AgentRuntime["createAgent"]>>; appCalls: Record<string, number> };
type Scenario = { systemPrompt: string; tools?: Tools; run(run: Run): Promise<string[]> };
const arg = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : undefined; };
const DIR = ".agent-runtime/eval";

// (a) An app sends a CSV, a PDF and a PNG, and wants totals, a report and a chart (examples/file-report.ts).
function files(): Scenario {
  const regions = ["North", "South", "East", "West"];
  const rows = Array.from({ length: 48 }, (_, index) => ({ month: `2026-${String(1 + (index % 12)).padStart(2, "0")}`, region: regions[Math.floor(index / 12)], revenue: 1000 + ((index * 7919) % 2500) }));
  const csv = ["month,region,revenue", ...rows.map(row => `${row.month},${row.region},${row.revenue}`)].join("\n");
  const totals = Object.fromEntries(regions.map(region => [region, rows.filter(row => row.region === region).reduce((sum, row) => sum + row.revenue, 0)]));
  return {
    systemPrompt: "You are an analyst. Do arithmetic in js_exec with fs, never in your head. Keep replies short.",
    async run({ agent }) {
      const result = await agent.prompt(
        "Attached are sales.csv, policy.pdf and logo.png. In js_exec, read the CSV with fs and total revenue per region. " +
        "Check each total against the annual target stated in the PDF. Tell me the logo's main colour. " +
        "Write /workspace/out/report.md (a table of totals, which regions meet the target, the colour) and " +
        "/workspace/out/chart.svg (a bar chart of the totals), then present both with present_file.",
        { timeoutMs: 600_000, files: [
          { name: "sales.csv", data: new TextEncoder().encode(csv), contentType: "text/csv" },
          { name: "policy.pdf", data: pdf("Annual revenue target per region: 30000 USD."), contentType: "application/pdf" },
          { name: "logo.png", data: png(48, 48, [30, 90, 220]), contentType: "image/png" },
        ] },
      );
      const failures: string[] = [];
      const read = async (path: string) => { try { return new TextDecoder().decode((await agent.files.download(path)).data); } catch { return ""; } };
      const report = await read("/workspace/out/report.md");
      const presented = result.presented.map((file: { path: string }) => file.path);
      if (!presented.includes("/workspace/out/report.md") || !presented.includes("/workspace/out/chart.svg")) failures.push("both files presented");
      for (const [region, total] of Object.entries(totals)) if (!report.includes(String(total)) && !report.includes(total.toLocaleString("en-US"))) failures.push(`report has ${region}'s total`);
      if (!/blue/i.test(report)) failures.push("report names the colour");
      if (!/<svg/i.test(await read("/workspace/out/chart.svg"))) failures.push("chart is an SVG");
      return failures;
    },
  };
}

// (b) Finding the right two tools among 60 in six namespaces, with plausible neighbours.
function discovery(): Scenario {
  const tools: Tools = {};
  const invoice = { id: "INV-2041", customerId: "cus_8812", status: "paid", amount: "$129.00" };
  // Reads answer with plausible records; anything else just succeeds.
  const noop = (name: string, description: string, input: Record<string, ReturnType<typeof schema.String>> = {}) => {
    const value = /__(get|list)_invoices?$/.test(name) ? (name.endsWith("s") ? { invoices: [invoice] } : invoice) : /__(get|list|search)/.test(name) ? { results: [] } : { ok: true };
    tools[name] = tool({ description, input: schema.Object(input, { additionalProperties: false }), execute: () => value });
  };
  const id = (description: string) => schema.String({ description });
  noop("crm__search_contacts", "Search marketing contacts (leads, not customers) by name or email.", { query: id("Text to match") });
  noop("crm__update_customer", "Update a customer's name, email or address.", { customerId: id("cus_…"), email: id("New email") });
  noop("crm__list_customers", "List customers, newest first, 50 at a time.", { cursor: id("Page cursor") });
  noop("crm__delete_customer", "Delete a customer and their data.", { customerId: id("cus_…") });
  noop("crm__merge_customers", "Merge two customer records.", { from: id("cus_…"), into: id("cus_…") });
  noop("crm__add_note", "Add a note to a customer.", { customerId: id("cus_…"), text: id("Note") });
  noop("crm__list_notes", "List a customer's notes.", { customerId: id("cus_…") });
  noop("crm__tag_customer", "Tag a customer.", { customerId: id("cus_…"), tag: id("Tag") });
  const found: Record<string, unknown> = { id: "cus_8812", name: "Dana Ruiz", email: "dana.ruiz@example.com" };
  tools.crm__get_customer = tool({ description: "Get a customer by customer id.", input: schema.Object({ customerId: id("cus_…") }, { additionalProperties: false }),
    execute: ({ customerId }) => customerId === found.id ? found : { error: "No such customer" } });
  tools.crm__find_customer_by_email = tool({ description: "Find a customer by their exact email address.", input: schema.Object({ email: schema.String() }, { additionalProperties: false }),
    execute: ({ email }) => email.toLowerCase() === found.email ? found : { error: "No customer with that email" } });
  noop("billing__list_invoices", "List a customer's invoices.", { customerId: id("cus_…") });
  noop("billing__get_invoice", "Get an invoice by id.", { invoiceId: id("INV-…") });
  noop("billing__void_invoice", "Void an unpaid invoice.", { invoiceId: id("INV-…") });
  noop("billing__create_credit_note", "Issue a credit note against an invoice, for a future purchase.", { invoiceId: id("INV-…") });
  noop("billing__refund_payment", "Refund a card payment by payment id (pay_…).", { paymentId: id("pay_…") });
  noop("billing__create_invoice", "Create an invoice for a customer.", { customerId: id("cus_…") });
  noop("billing__send_invoice", "Email an invoice to its customer.", { invoiceId: id("INV-…") });
  noop("billing__list_payments", "List a customer's payments.", { customerId: id("cus_…") });
  noop("billing__update_payment_method", "Change a customer's default payment method.", { customerId: id("cus_…") });
  const refunds: unknown[] = [];
  tools.billing__refund_invoice = tool({ description: "Refund a paid invoice in full to the customer's original payment method.", input: schema.Object({ customerId: schema.String(), invoiceId: schema.String(), reason: schema.Optional(schema.String()) }, { additionalProperties: false }),
    execute: args => { refunds.push(args); return args.customerId === "cus_8812" && args.invoiceId === "INV-2041" ? { refunded: true, refundId: "re_551", amount: "$129.00" } : { error: "Invoice not found for this customer" }; } });
  for (const [namespace, things] of Object.entries({ support: ["ticket", "macro", "sla", "agent"], inventory: ["sku", "warehouse", "stock", "transfer"], marketing: ["campaign", "segment", "email", "coupon"], hr: ["employee", "leave", "payslip", "review"] })) {
    for (const thing of things) {
      noop(`${namespace}__list_${thing}s`, `List ${thing}s.`);
      noop(`${namespace}__get_${thing}`, `Get a ${thing} by id.`, { id: id("Id") });
    }
    noop(`${namespace}__search`, `Search ${namespace} records by text.`, { query: id("Text") });
    noop(`${namespace}__export`, `Export ${namespace} data as CSV.`);
  }
  return {
    systemPrompt: "You are the back-office assistant for a small online shop. Act on requests without asking for confirmation. Keep replies short.",
    tools,
    async run({ agent, appCalls }) {
      const result = await agent.prompt("Dana Ruiz (dana.ruiz@example.com) was double charged. Refund her invoice INV-2041.", { timeoutMs: 600_000 });
      const failures: string[] = [];
      if (refunds.length !== 1 || JSON.stringify(refunds[0]).indexOf("cus_8812") < 0) failures.push("refunded INV-2041 once, for cus_8812");
      for (const wrong of ["billing__void_invoice", "billing__create_credit_note", "billing__refund_payment", "crm__update_customer"]) if (appCalls[wrong]) failures.push(`did not call ${wrong}`);
      if (!/re_551|refund/i.test(result.reply ?? "")) failures.push("reply confirms the refund");
      return failures;
    },
  };
}

// (c) A dataset fetched in pages, then questions about it over two turns: variables are gone by
// the second, so state carries in files (or the data is fetched again).
function state(): Scenario {
  const regions = ["North", "South", "East", "West"];
  const products = ["Anvil", "Bolt", "Crank", "Dynamo", "Gear"];
  const orders = Array.from({ length: 600 }, (_, index) => ({
    id: `ord_${10_000 + index}`, date: `2026-${String(1 + (index * 7) % 12).padStart(2, "0")}-${String(1 + (index * 13) % 28).padStart(2, "0")}`,
    region: regions[(index * 3) % 4], product: products[(index * 7 + Math.floor(index / 5)) % 5], units: 1 + (index * 37) % 9, unitPrice: 5 + (index * 11) % 40, refunded: index % 17 === 0,
  }));
  const revenue = Object.fromEntries(regions.map(region => [region, orders.filter(order => order.region === region && !order.refunded).reduce((sum, order) => sum + order.units * order.unitPrice, 0)]));
  const q2 = orders.filter(order => order.region === "West" && ["04", "05", "06"].includes(order.date.slice(5, 7)) && !order.refunded);
  const units = Object.fromEntries(products.map(product => [product, q2.filter(order => order.product === product).reduce((sum, order) => sum + order.units, 0)]));
  const top = Object.entries(units).sort((a, b) => b[1] - a[1]);
  if (top[0][1] === top[1][1]) throw new Error("The state scenario's data has a tie");
  const refunded = orders.filter(order => order.refunded).length;
  const PAGE = 100;
  return {
    systemPrompt: "You are an analyst for an equipment wholesaler. Compute in js_exec; never estimate. Keep replies short.",
    tools: {
      orders__list: tool({ description: `List orders, ${PAGE} per page (page from 1). Each order: id, date, region, product, units, unitPrice, refunded. nextPage is null on the last page.`,
        input: schema.Object({ page: schema.Integer({ minimum: 1 }) }, { additionalProperties: false }),
        execute: ({ page }) => ({ orders: orders.slice((page - 1) * PAGE, page * PAGE), nextPage: page * PAGE < orders.length ? page + 1 : null }) }),
      orders__get: tool({ description: "Get one order by id.", input: schema.Object({ id: schema.String() }, { additionalProperties: false }), execute: ({ id }) => orders.find(order => order.id === id) ?? null }),
    },
    async run({ agent }) {
      const failures: string[] = [];
      const first = await agent.prompt("Pull all our orders and give me revenue (units × unitPrice) per region, excluding refunded orders. I'll have follow-up questions on the same data.", { timeoutMs: 600_000 });
      const numbers = (text = "") => text.replace(/(\d),(\d{3})/g, "$1$2");
      for (const [region, total] of Object.entries(revenue)) if (!numbers(first.reply).includes(String(total))) failures.push(`turn 1 has ${region}'s revenue ${total}`);
      const second = await agent.prompt("Which product sold the most units in the West region in Q2 (April–June), excluding refunds? And how many orders were refunded in total?", { timeoutMs: 600_000 });
      if (!new RegExp(top[0][0], "i").test(second.reply ?? "")) failures.push(`turn 2 names ${top[0][0]}`);
      if (!new RegExp(`\\b${refunded}\\b`).test(second.reply ?? "")) failures.push(`turn 2 counts ${refunded} refunds`);
      return failures;
    },
  };
}

// (d) A plain question: no tools needed, so this measures what the runtime's prompt costs.
function plain(): Scenario {
  return {
    systemPrompt: "You are a helpful assistant. Keep replies short.",
    async run({ agent }) {
      const result = await agent.prompt("In one sentence: why is the sky blue?", { timeoutMs: 120_000 });
      return /scatter/i.test(result.reply ?? "") ? [] : ["reply explains scattering"];
    },
  };
}

// (e) "List my apps" (a real staging turn): 125 apps of about 350 characters each, at most 100
// per call. Returned whole they pass the output limit, so the model must read what came back.
function list(): Scenario {
  const words = ["atlas", "beacon", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "iris", "juniper", "kelp", "lumen", "moss"];
  const apps = Array.from({ length: 125 }, (_, index) => {
    const name = `${words[index % 13]}-${words[(index * 5 + 3) % 13]}-${index}`;
    const updated = new Date(Date.UTC(2026, 0, 1) + ((index * 7919) % 2600) * 3_600_000).toISOString();
    return { name, url: `https://${name}--workspace-d05.camelai.app`, is_public: index % 3 === 0, created_by: "7f5110a2-856a-4dd3-91a7-90a848ea63d9", created_at: updated, updated_at: updated,
      preview_status: index % 11 === 4 ? "failed" : index % 17 === 9 ? "pending" : "ready", project_id: `ca-bce87a9c129b474896a1e7f569b153fc-${name}`, commit_sha: (index * 2654435761).toString(16).padStart(8, "0").repeat(8) };
  });
  const unready = apps.filter(app => app.preview_status !== "ready");
  const sorts: Record<string, (a: typeof apps[0], b: typeof apps[0]) => number> = {
    updated_desc: (a, b) => b.updated_at.localeCompare(a.updated_at), updated_asc: (a, b) => a.updated_at.localeCompare(b.updated_at), name_asc: (a, b) => a.name.localeCompare(b.name),
  };
  return {
    systemPrompt: "You are the assistant for an app hosting platform. Keep replies short.",
    tools: {
      apps__list_apps: tool({ description: "List the workspace's apps, newest first by default.", exposure: "codemode",
        input: schema.Object({ limit: schema.Optional(schema.Integer({ minimum: 1, maximum: 100 })), sort: schema.Optional(schema.Union(Object.keys(sorts).map(key => schema.Literal(key)))) }, { additionalProperties: false }),
        execute: ({ limit = 100, sort = "updated_desc" }) => { const page = apps.toSorted(sorts[sort]).slice(0, limit); return { total: apps.length, count: page.length, filters: { sort }, apps: page }; } }),
    },
    async run({ agent }) {
      const result = await agent.prompt("hey can you list my apps? which ones aren't ready?", { timeoutMs: 600_000 });
      const failures: string[] = [];
      if (!/\b125\b/.test(result.reply ?? "")) failures.push("reply counts 125 apps");
      for (const app of unready) if (!(result.reply ?? "").includes(app.name)) failures.push(`reply names ${app.name} (${app.preview_status})`);
      return failures;
    },
  };
}

const SCENARIOS: Record<string, () => Scenario> = { files, discovery, state, plain, list };

async function evaluate(label: string, name: string, index: number) {
  const scenario = SCENARIOS[name]();
  const appCalls: Record<string, number> = {};
  const tools = Object.fromEntries(Object.entries(scenario.tools ?? {}).map(([toolName, definition]) => [toolName, { ...definition,
    execute: (args: any, context: any) => { appCalls[toolName] = (appCalls[toolName] ?? 0) + 1; return definition.execute(args, context); } }]));
  const toolCalls: Record<string, number> = {};
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let turns = 0;
  const log = `${DIR}/${label}/${name}-${index}.jsonl`;
  mkdirSync(`${DIR}/${label}`, { recursive: true });
  writeFileSync(log, "");
  const runtime = new AgentRuntime({ url: process.env.AGENT_URL, apiKey: process.env.AGENT_RUNTIME_TOKEN });
  const started = Date.now();
  const agent = await runtime.createAgent({
    name: `eval ${name}`, model: process.env.AGENT_MODEL ?? "anthropic/claude-sonnet-5", systemPrompt: scenario.systemPrompt, tools, ttlSeconds: 3600,
    onEvent(event) {
      if (event.type === "tool_execution_start") {
        toolCalls[event.toolName] = (toolCalls[event.toolName] ?? 0) + 1;
        appendFileSync(log, JSON.stringify({ call: event.toolName, args: event.args }) + "\n");
      }
      if (event.type === "tool_execution_end") appendFileSync(log, JSON.stringify({ result: event.toolName, isError: event.isError, text: JSON.stringify((event.result as any)?.content ?? event.result).slice(0, 2000) }) + "\n");
      if (event.type === "message_end" && event.message?.role === "assistant") {
        turns++;
        const u: any = event.message.usage ?? {};
        usage.input += u.input ?? 0; usage.output += u.output ?? 0; usage.cacheRead += u.cacheRead ?? 0; usage.cacheWrite += u.cacheWrite ?? 0; usage.cost += u.cost?.total ?? 0;
        appendFileSync(log, JSON.stringify({ assistant: event.message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"), stopReason: event.message.stopReason }) + "\n");
      }
    },
  });
  let failures: string[];
  try { failures = await scenario.run({ agent, appCalls }); }
  catch (error) { failures = [`error: ${(error as Error).message}`]; }
  finally { await agent.destroy().catch(() => {}); }
  const row = { label, scenario: name, run: index, model: process.env.AGENT_MODEL ?? "anthropic/claude-sonnet-5", success: !failures.length, failures,
    toolCalls, jsExec: toolCalls.js_exec ?? 0, calls: Object.values(toolCalls).reduce((a, b) => a + b, 0), appCalls, turns, ...usage, wallMs: Date.now() - started };
  appendFileSync(`${DIR}/${label}.jsonl`, JSON.stringify(row) + "\n");
  console.log(`${name} #${index}: ${row.success ? "ok" : `FAILED (${failures.join("; ")})`}, ${row.calls} calls (${row.jsExec} js_exec), ${turns} turns, ${usage.input + usage.cacheRead + usage.cacheWrite} in / ${usage.output} out, $${usage.cost.toFixed(3)}, ${(row.wallMs / 1000).toFixed(0)} s`);
  return row;
}

/** Means per label and scenario, from result files. */
function summary(paths: string[]) {
  const rows = paths.flatMap(path => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)));
  const groups = Map.groupBy(rows, row => `${row.scenario}\t${row.label}`);
  const mean = (list: any[], key: (row: any) => number) => (list.reduce((sum, row) => sum + key(row), 0) / list.length);
  console.log("| scenario | label | runs | success | tool calls | js_exec | turns | input tokens | output tokens | cost | wall s |\n|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [key, list] of [...groups].sort()) {
    const [scenario, label] = key.split("\t");
    console.log(`| ${scenario} | ${label} | ${list.length} | ${list.filter(row => row.success).length}/${list.length} | ${mean(list, row => row.calls).toFixed(1)} | ${mean(list, row => row.jsExec).toFixed(1)} | ${mean(list, row => row.turns).toFixed(1)} | ${mean(list, row => row.input + row.cacheRead + row.cacheWrite).toFixed(0)} | ${mean(list, row => row.output).toFixed(0)} | $${mean(list, row => row.cost).toFixed(3)} | ${mean(list, row => row.wallMs / 1000).toFixed(0)} |`);
  }
}

if (process.argv.includes("--summary")) summary(process.argv.slice(process.argv.indexOf("--summary") + 1));
else {
  const label = arg("label") ?? "run";
  const runs = Number(arg("runs") ?? 3);
  const names = (arg("scenarios") ?? Object.keys(SCENARIOS).join(",")).split(",");
  for (const name of names) if (!SCENARIOS[name]) throw new Error(`Unknown scenario ${name}; one of ${Object.keys(SCENARIOS).join(", ")}`);
  // Scenarios run side by side; each one's runs in turn.
  await Promise.all(names.map(async name => { for (let index = 1; index <= runs; index++) await evaluate(label, name, index); }));
  summary([`${DIR}/${label}.jsonl`]);
}
