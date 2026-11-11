// The reference workflow for s-esm-refactor (workflow-direct mode): a lead lists the modules, a worker per module,
// a critic per batch of ten, fixes, then the package-level steps. Designed phase-1 globals only.
// ASSUMPTION to check when PR 7 lands: how a child mounts the task's volume (here `files` with the volume id).
export const meta = { name: "esm-refactor", description: "Migrate each module, review in batches, finish the package", phases: [{ title: "Migrate" }, { title: "Review" }, { title: "Package" }] };
const FINDINGS = { type: "object", properties: { findings: { type: "array", items: { type: "object", properties: { file: { type: "string" }, problem: { type: "string" } }, required: ["file", "problem"], additionalProperties: false } } }, required: ["findings"], additionalProperties: false };
const files = { volume: args.volume, path: "/workspace", mode: "rw" };
const modules = Array.from({ length: 50 }, (_, index) => `lib/m${String(index + 1).padStart(2, "0")}.js`);

phase("Migrate");
await parallel(modules.map((file) => () => agent(`${args.instructions}\nModule: /workspace/${file}`, { key: `migrate:${file}`, type: "worker", class: args.workerClass, files, label: file })));
phase("Review");
const batches = Array.from({ length: 5 }, (_, index) => modules.slice(index * 10, index * 10 + 10));
const reviews = await parallel(batches.map((batch, index) => () => agent(
  `Check that each of these modules is a correct ES module migration per /workspace/MIGRATION.md and prints exactly what legacyFormat printed (mind %d truncation, %j, %%): ${batch.join(", ")}. Only report; never edit.`,
  { key: `review:${index}`, type: "critic", output: FINDINGS, files: { ...files, mode: "ro" } })));
const findings = reviews.filter(Boolean).flatMap((review) => review.findings);
await parallel([...new Set(findings.map((finding) => finding.file))].map((file) => () => agent(
  `Fix these problems in /workspace/${file}:\n${findings.filter((finding) => finding.file === file).map((finding) => finding.problem).join("\n")}`,
  { key: `fix:${file}`, type: "worker", class: args.workerClass, files })));
phase("Package");
await agent('In /workspace: make lib/index.js re-export each module as a namespace (export * as m01 from "./m01.js"), set "type": "module" in package.json, and delete util/legacy-format.js. Change nothing else.', { key: "package", type: "worker", class: args.workerClass, files });
return { modules: modules.length, findings: findings.length };
