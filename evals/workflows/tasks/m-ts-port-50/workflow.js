// The reference workflow for m-ts-port-50 (workflow-direct mode): a worker per batch of five modules, each on its own
// fork, committed back; then one worker for lib/index.ts, util/ and package.json; a critic checks the whole port.
// Children are made from the run's definitions (`args.definitions`); the harness inlines `args` and strips `export`.
const meta = { name: "ts-port-50" };
const modules = Array.from({ length: 50 }, (_, index) => `lib/m${String(index + 1).padStart(2, "0")}.js`);
const batches = Array.from({ length: 10 }, (_, index) => modules.slice(index * 5, index * 5 + 5));
const ported = await parallel(batches.map((batch, index) => () => agent(
  `Port these CommonJS modules of /repo to TypeScript ES modules: ${batch.join(", ")}. Same exports and behaviour for any input, strict types (tsconfig.json), erasable syntax only, imports with .ts; module.exports = fn becomes export default with its other properties as named exports. Write each .ts beside its .js, delete the .js, change nothing else.`,
  { key: `port:${index}`, type: "worker", definition: args.definitions.worker, repo: args.volume })));
for (const result of ported.filter(Boolean)) if (result.fork) await commit(result.fork);
const rest = await agent("Port /repo/lib/index.js and /repo/util/legacy-format.js to TypeScript (.ts, delete the .js), make lib/index.ts re-export each module as a namespace, and set \"type\": \"module\" in /repo/package.json.",
  { key: "package", type: "worker", definition: args.definitions.worker, repo: args.volume });
if (rest?.fork) await commit(rest.fork);
const review = await agent("Check the TypeScript port in /repo: every lib/mNN.ts keeps its exports and behaviour, imports use .ts, no .js is left in lib/ or util/. List problems only.",
  { key: "review", type: "critic", definition: args.definitions.critic, output: { type: "object", properties: { problems: { type: "array", items: { type: "string" } } }, required: ["problems"], additionalProperties: false } });
log(`review: ${review?.problems?.length ?? "no"} problems`);
return { batches: batches.length, problems: review?.problems ?? [] };
