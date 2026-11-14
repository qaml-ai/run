// The reference workflow for m-toml-go (workflow-direct mode): a lead fixes the Go package's shape, a worker ports
// each TypeScript file against it, critics review each file against the original, fixers apply findings.
const meta = { name: "toml-go", phases: [{ title: "Plan" }, { title: "Port" }, { title: "Review" }, { title: "Fix" }] };
const FINDINGS = { type: "object", properties: { findings: { type: "array", items: { type: "string" } } }, required: ["findings"], additionalProperties: false };
const go = (file) => `go/${file.replace(/^src\//, "").replace(/\.ts$/, ".go")}`;

log("Plan");
await agent("Read /workspace/src and PROTOCOL.md. Write /workspace/go/PLAN.md: the Go package's files (one per TypeScript file), every exported type and function with its Go signature, the error type, how TOML dates and times are represented, and what cmd/toml-decoder and cmd/toml-encoder do. Standard library only.", { key: "plan", type: "lead", definition: args.definitions.lead });
log("Port");
await parallel([...args.files, "cmd/toml-decoder", "cmd/toml-encoder"].map((file) => () => agent(
  file.startsWith("cmd/") ? `Write /workspace/go/${file}/main.go following /workspace/go/PLAN.md and PROTOCOL.md (as toml-test-${file.endsWith("decoder") ? "parse" : "encode"}.mjs does for the TypeScript).` : `Port /workspace/${file} to /workspace/${go(file)} following /workspace/go/PLAN.md exactly: same behaviour, the plan's signatures, standard library only.`,
  { key: `port:${file}`, type: "worker", definition: args.definitions.worker, label: file })));
log("Review");
const reviews = await parallel(args.files.map((file) => () => agent(
  `Compare /workspace/${go(file)} with /workspace/${file} and /workspace/go/PLAN.md. List every behaviour difference, compile error and missing case. Only report; never edit.`,
  { key: `review:${file}`, type: "critic", definition: args.definitions.critic, output: FINDINGS })));
log("Fix");
await parallel(args.files.map((file, index) => () => reviews[index]?.findings?.length
  ? agent(`Fix these findings in /workspace/${go(file)}:\n${reviews[index].findings.join("\n")}`, { key: `fix:${file}`, type: "worker", definition: args.definitions.worker })
  : null));
return { files: args.files.length };
