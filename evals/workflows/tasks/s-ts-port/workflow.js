// The reference workflow for s-ts-port (workflow-direct mode): a worker per file, a critic per file, a fixer where
// the critic found something, then one critic over the whole port. Written against the designed phase-1 globals
// (docs/design/swarm-workflows.md, The script): agent, parallel with explicit keys, phase, log, args.
// Children are made from the run's worker, critic and lead definitions (`args.definitions`), which mount the task's
// volume at /workspace and carry the model class; `type` is kept for when PR 8 makes it an option of agent().
// The harness inlines `args` as a const and strips `export`, as the runner evaluates the script as a function body.
export const meta = { name: "ts-port", description: "Port each file, review it, fix it", phases: [{ title: "Port" }, { title: "Review" }, { title: "Fix" }, { title: "Final review" }] };
const FINDINGS = { type: "object", properties: { findings: { type: "array", items: { type: "string" } } }, required: ["findings"], additionalProperties: false };
const ts = (file) => file.replace(/\.js$/, ".ts");

phase("Port");
await parallel(args.files.map((file) => () => agent(`${args.instructions}\nFile: /workspace/${file}`, { key: `port:${file}`, type: "worker", definition: args.definitions.worker, label: file })));
phase("Review");
const reviews = await parallel(args.files.map((file) => () => agent(
  `Compare /workspace/${ts(file)} with the original JavaScript behaviour described by the tests and the other modules. List every behaviour change, loose type, stub or missing case. Only report; never edit.`,
  { key: `review:${file}`, type: "critic", definition: args.definitions.critic, output: FINDINGS, label: file })));
phase("Fix");
await parallel(args.files.map((file, index) => () => reviews[index]?.findings?.length
  ? agent(`Fix these review findings in /workspace/${ts(file)}:\n${reviews[index].findings.join("\n")}`, { key: `fix:${file}`, type: "worker", definition: args.definitions.worker, label: file })
  : null));
phase("Final review");
const final = await agent("Review the whole TypeScript port in /workspace/src and /workspace/test: imports with .ts extensions, no .js left in src, strict types, every test case kept. List problems only.", { key: "final-review", type: "critic", definition: args.definitions.critic, output: FINDINGS });
log(`final review: ${final?.findings?.length ?? "no"} findings`);
return { files: args.files.length, finalFindings: final?.findings ?? [] };
