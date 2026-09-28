import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { Agents, schema, tool } from "@camelai/agent-runtime";

// A throwaway folder for the agent to tidy.
const dir = "playground";
await mkdir(dir, { recursive: true });
for (const f of ["notes.md", "build.log", "cache.tmp", "old-draft.tmp"]) await writeFile(`${dir}/${f}`, "x");

const agents = new Agents();
const agent = await agents.upsert("approval-ts", {
  model: "openrouter/openai/gpt-6-luna",
  instructions: "You tidy the user's playground folder with your tools.",
  tools: {
    list_files: tool({
      description: "List the files in the playground",
      input: schema.Object({}),
      execute: () => readdir(dir),
    }),
    delete_file: tool({
      description: "Delete a file from the playground",
      input: schema.Object({ name: schema.String() }),
      needsApproval: true, // the run stops and waits for a person before each call
      execute: async ({ name }) => (await rm(`${dir}/${basename(name)}`), { deleted: name }),
    }),
  },
});

const cli = createInterface({ input: process.stdin, output: process.stdout });
let run = await agent.run(process.argv.slice(2).join(" ") || "Delete the temporary files.", { user: "me" });
while (run.status === "input_required") {
  const input = run.inputs[0];
  const yes = (await cli.question(`${input.message} ${input.detail.argumentsPreview ?? JSON.stringify(input.detail.arguments)} [y/N] `)).trim() === "y";
  run = await input.answer(yes, { from: "me" });
}
console.log(run.text, "\nleft:", await readdir(dir));
cli.close();
await agents.close();
