/**
 * An application's own data as tools: the agent reads the release board and saves a note, in this process.
 * By default it runs scripted code with the tools (no model); --prompt "…" asks the model instead.
 *
 *   CAMELAI_API_KEY=art_… node --experimental-strip-types examples/release-board.ts --prompt "Are we ready to ship?"
 */
import { Agents, schema, tool } from "../clients/typescript.ts";

// Your existing TypeScript app owns this state. The agent never imports it.
const issues = [
  { id: "APP-41", title: "Checkout retry duplicates receipts", severity: "high", owner: "Payments", status: "open" },
  { id: "APP-42", title: "Search loses keyboard focus", severity: "medium", owner: "Web", status: "open" },
  { id: "APP-43", title: "CSV export missing timezone", severity: "high", owner: "Data", status: "resolved" },
];
let releaseNote = "";

const agents = new Agents();
const agent = await agents.upsert("release-board", {
  ...(process.env.AGENT_MODEL ? { model: process.env.AGENT_MODEL } : {}),
  instructions: "You review release readiness from the issue board. Save clear, concise release notes.",
  tools: {
    list_issues: tool({
      description: "Read the release board, including severity, owner and status.",
      input: schema.Object({}, { additionalProperties: false }),
      execute: () => issues,
    }),
    save_release_note: tool({
      description: "Replace the local release readiness note. No publishing or external messages.",
      input: schema.Object({ note: schema.String({ maxLength: 4000 }) }, { additionalProperties: false }),
      execute: ({ note }) => {
        releaseNote = note; // note is inferred as string from the schema.
        return { saved: true, note: releaseNote };
      },
    }),
  },
});
try {
  console.log(`\nTypeScript release board → hosted agent ${agent.id}`);
  const promptIndex = process.argv.indexOf("--prompt");
  if (promptIndex >= 0) {
    const run = await agent.run(process.argv[promptIndex + 1] ?? "Inspect the release board and save a concise go/no-go release note with unresolved blockers and owners.");
    console.log(run.text);
  } else {
    // Code the model could have written, run in the agent's sandbox with its tools (no model call).
    const result = await agent.client.execute(`
      const issues = await tools.list_issues({});
      const blockers = issues.filter(issue => issue.severity === "high" && issue.status !== "resolved");
      const note = blockers.length ? "HOLD release: " + blockers.map(issue => issue.id + " — " + issue.title + " (" + issue.owner + ")").join("; ") : "Ready to ship";
      return await tools.save_release_note({note});
    `);
    console.log(JSON.stringify({ agentResult: result }, null, 2));
  }
  console.log(JSON.stringify({ localReleaseNote: releaseNote }, null, 2));
} finally {
  await agents.close();
}
