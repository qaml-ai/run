// The simulator as an MCP server over stdio, for an agent (Claude Code, say) to drive: `npm run -s sim:mcp`, here or
// over ssh (`ssh camel-devbox 'cd <checkout> && npm run -s sim:mcp'`). No network listener. See tests/sim/README.md.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CAPS, SimLab } from "./lab.ts";

/** The lab's tools on an MCP server: each answers compact JSON, with limits and ids for asking for more. */
export function simServer(lab: SimLab) {
  const server = new McpServer({ name: "camelrun-sim", version: "1.0.0" });
  const answer = async (work: () => unknown) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await work()) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: (error as Error).message }] }; }
  };
  const RunId = z.string().regex(/^r\d+$/).describe("A run's id, as run_plan, run_seeds, branch, minimize or replay gave it");

  server.registerTool("schema", {
    description: "The plan format (JSON Schema): nodes, settings, and every step's op with its parameters (faults included); the caps; what each checker (I1, I2, I3...) checks; the BUGGIFY sites; an example plan",
    inputSchema: {},
  }, () => answer(() => lab.schema()));

  server.registerTool("goals", {
    description: "Every coverage goal (sometimes/reachable in the runtime's code): its source location and line, and whether this server's runs or the corpus reached it. all: also always/unreachable points. context: lines of source around each",
    inputSchema: { all: z.boolean().optional(), context: z.number().int().min(0).max(20).optional() },
  }, ({ all, context }) => answer(() => lab.goals({ all, context })));

  server.registerTool("run_plan", {
    description: `Validate a plan (errors listed) and run it: failures, goals and assertions newly reached in this session, new coverage (blocks of src/ and shared/ no earlier run here covered), BUGGIFY sites fired, trace hash, virtual ms, and the client calls step by step. twice: run it again and check it hashes the same. Caps: ${CAPS.durationMs / 60_000} virtual minutes, ${CAPS.steps} steps, ${CAPS.nodes} nodes. One sim runs at a time.`,
    inputSchema: { plan: z.record(z.string(), z.unknown()).describe("A plan as the schema tool gives it"), twice: z.boolean().optional(), lines: z.number().int().min(0).max(400).optional().describe("Trace lines to give (default 30)") },
  }, ({ plan, twice, lines }) => answer(() => lab.runPlan(plan, { twice, lines })));

  server.registerTool("run_seeds", {
    description: `Run the generated plans for seeds from..to (at most ${CAPS.seeds}, ${CAPS.batchWallMs / 60_000} minutes): the runs that failed, and the ones that covered something new, by run id`,
    inputSchema: { from: z.number().int().min(0), to: z.number().int().min(0) },
  }, ({ from, to }) => answer(() => lab.runSeeds(from, to)));

  server.registerTool("fuzz", {
    description: `Coverage-guided fuzzing in this server for some minutes (at most ${CAPS.fuzzMinutes}), drawing on and adding to the corpus: what it ran and kept, goals and features in the corpus, new failures (saved and minimized under sim-failures/fuzz; replay them by file), and the plans it added (replay them by corpus name)`,
    inputSchema: { minutes: z.number().min(0.1).max(CAPS.fuzzMinutes) },
  }, ({ minutes }) => answer(() => lab.fuzz(minutes)));

  server.registerTool("inspect", {
    description: "Slices of a run: logs (a substring, or /regex/flags, over 'node line'), history (client calls [from, to)), trace (filtered timers, statements, connections, calls), an agent as the run left it (its requests, state and history), state (ownership rows, heartbeats, agents' pending runs), plan. limit: lines per slice (default 50)",
    inputSchema: {
      runId: RunId, logs: z.string().optional(), history: z.tuple([z.number().int(), z.number().int()]).optional(), trace: z.string().optional(),
      agent: z.number().int().min(0).optional(), state: z.boolean().optional(), plan: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional(),
    },
  }, ({ runId, ...options }) => answer(() => lab.inspect(runId, options)));

  server.registerTool("minimize", {
    description: "Cut a failing run's plan down to the steps its failure needs (delta debugging), then run the smaller plan: its new run id and summary",
    inputSchema: { runId: RunId },
  }, ({ runId }) => answer(() => lab.minimize(runId)));

  server.registerTool("replay", {
    description: "Run a plan again: a run's (runId), a corpus entry's (corpus: its name), or a saved one (file: a path in the checkout, such as sim-failures/fuzz/<id>.min.json)",
    inputSchema: { runId: RunId.optional(), corpus: z.string().optional(), file: z.string().optional(), twice: z.boolean().optional() },
  }, ({ twice, ...source }) => answer(() => lab.replay(source, { twice })));

  server.registerTool("branch", {
    description: `Keep a run's first k steps and draw the rest at random, n times (at most ${CAPS.branches}): each new run's id, failures, new coverage and goals`,
    inputSchema: { runId: RunId, k: z.number().int().min(0), n: z.number().int().min(1).max(CAPS.branches) },
  }, ({ runId, k, n }) => answer(() => lab.branch(runId, k, n)));

  server.registerTool("corpus_add", {
    description: "Keep a run's plan in the fuzzing corpus (sim-corpus/), with a note on what it is for",
    inputSchema: { runId: RunId, note: z.string().max(500) },
  }, ({ runId, note }) => answer(() => lab.corpusAdd(runId, note)));

  server.registerTool("corpus_list", {
    description: "The corpus's plans: name, steps, goals reached, behaviour added, how it was made, note",
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
  }, ({ limit }) => answer(() => lab.corpusList(limit)));

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Stdout is the protocol: anything else written there would corrupt it.
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  const lab = new SimLab();
  await lab.start();
  await simServer(lab).connect(new StdioServerTransport());
}
