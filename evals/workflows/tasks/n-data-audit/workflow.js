// The reference workflow for n-data-audit (workflow-direct mode): a worker per table, a critic on each table's
// findings, a lead to merge them into findings.json. Designed phase-1 globals only.
// Children are made from the run's worker, critic and lead definitions (`args.definitions`), which mount the task's
// volume at /workspace and carry the model class; `type` is kept for when PR 8 makes it an option of agent().
// The harness inlines `args` as a const and strips `export`, as the runner evaluates the script as a function body.
export const meta = { name: "data-audit", description: "Audit each table, confirm, merge", phases: [{ title: "Audit" }, { title: "Confirm" }, { title: "Merge" }] };
const FINDINGS = { type: "object", properties: { findings: { type: "array", items: { type: "object", properties: { table: { type: "string" }, column: { type: "string" }, kind: { type: "string" }, rows: { type: "array", items: { type: "integer" } }, note: { type: "string" } }, required: ["table", "column", "kind", "rows"], additionalProperties: false } } }, required: ["findings"], additionalProperties: false };

log("Audit");
const audits = await parallel(args.tables.map((table) => () => agent(
  `Audit /workspace/tables/${table}.csv against its rules in /workspace/SCHEMA.md, including references to other tables (read those tables' keys). Compute in code mode. Report every (column, kind) that breaks a rule, with up to 5 one-based data row numbers.`,
  { key: `audit:${table}`, type: "worker", definition: args.definitions.worker, output: FINDINGS, label: table })));
log("Confirm");
const confirmed = await parallel(args.tables.map((table, index) => () => audits[index]?.findings?.length
  ? agent(`Check each finding against /workspace/tables/${table}.csv and SCHEMA.md; return only the ones that are real rule violations.\n${JSON.stringify(audits[index].findings)}`, { key: `confirm:${table}`, type: "critic", definition: args.definitions.critic, output: FINDINGS, label: table })
  : { findings: [] }));
log("Merge");
await agent(`Write /workspace/findings.json as a JSON array of these findings, one per (table, column, kind), as they are:\n${JSON.stringify(confirmed.filter(Boolean).flatMap((result) => result.findings))}`,
  { key: "merge", type: "lead", definition: args.definitions.lead });
return { tables: args.tables.length };
