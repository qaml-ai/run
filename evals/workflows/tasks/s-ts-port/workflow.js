// The reference workflow for s-ts-port (workflow-direct mode): a worker per file, a critic per file, a fixer where
// the critic found something, then one critic over the whole port. Written against the designed phase-1 globals
// (docs/design/swarm-workflows.md, The script): agent, parallel with explicit keys, phase, log, args.
// ASSUMPTION to check when PR 7 lands: how a child mounts the task's volume (here `files` with the volume id).
export const meta = { name: "ts-port", description: "Port each file, review it, fix it", phases: [{ title: "Port" }, { title: "Review" }, { title: "Fix" }, { title: "Final review" }] };
const FINDINGS = { type: "object", properties: { findings: { type: "array", items: { type: "string" } } }, required: ["findings"], additionalProperties: false };
const files = { volume: args.volume, path: "/workspace", mode: "rw" };
const ts = (file) => file.replace(/\.js$/, ".ts");

phase("Port");
await parallel(args.files.map((file) => () => agent(`${args.instructions}\nFile: /workspace/${file}`, { key: `port:${file}`, type: "worker", class: args.workerClass, files, label: file })));
phase("Review");
const reviews = await parallel(args.files.map((file) => () => agent(
  `Compare /workspace/${ts(file)} with the original JavaScript behaviour described by the tests and the other modules. List every behaviour change, loose type, stub or missing case. Only report; never edit.`,
  { key: `review:${file}`, type: "critic", output: FINDINGS, files: { ...files, mode: "ro" }, label: file })));
phase("Fix");
await parallel(args.files.map((file, index) => () => reviews[index]?.findings?.length
  ? agent(`Fix these review findings in /workspace/${ts(file)}:\n${reviews[index].findings.join("\n")}`, { key: `fix:${file}`, type: "worker", class: args.workerClass, files, label: file })
  : null));
phase("Final review");
const final = await agent("Review the whole TypeScript port in /workspace/src and /workspace/test: imports with .ts extensions, no .js left in src, strict types, every test case kept. List problems only.", { key: "final-review", type: "critic", output: FINDINGS, files: { ...files, mode: "ro" } });
log(`final review: ${final?.findings?.length ?? "no"} findings`);
return { files: args.files.length, finalFindings: final?.findings ?? [] };
