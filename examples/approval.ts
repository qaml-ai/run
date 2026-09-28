/**
 * A tool that needs a person's approval: the run stops with the input, and answering it resumes the run.
 * Here the answer comes from code; in an app it comes from a person, minutes or days later, from any process.
 *
 *   CAMELAI_API_KEY=art_… node --experimental-strip-types examples/approval.ts
 */
import { Agents, schema, tool } from "../clients/typescript.ts";

const deleted: string[] = [];
const agents = new Agents();
const agent = await agents.upsert("approval-example", {
  model: process.env.AGENT_MODEL ?? "anthropic/claude-sonnet-5",
  instructions: "You manage preview environments. Delete the ones you are asked to, with the tool.",
  tools: {
    delete_environment: tool({
      description: "Delete a preview environment",
      input: schema.Object({ name: schema.String() }),
      needsApproval: true,
      execute: ({ name }, context) => {
        // The stable key for this call: pass it to anything with side effects.
        deleted.push(`${name} (${context.idempotencyKey.slice(0, 8)})`);
        return { deleted: name };
      },
    }),
  },
});

try {
  let run = await agent.run("Delete the preview environment pr-4312.", { user: "alice" });
  while (run.status === "input_required") {
    const input = run.inputs[0];
    console.log(`waiting for ${input.kind}: ${input.message} ${JSON.stringify(input.detail.arguments ?? "")}`);
    run = await input.answer(true, { from: "alice" });
  }
  console.log(run.text);
  console.log("deleted:", deleted);
} finally {
  await agents.close();
}
