import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Agents, RunError, schema } from "../clients/node.ts";
import { OPERATOR, runtime, toolCall, toolResults } from "./runtime-server.ts";

const SCHEMA = {
  type: "object",
  properties: { sentiment: { type: "string", enum: ["positive", "neutral", "negative"] }, score: { type: "number" } },
  required: ["sentiment", "score"], additionalProperties: false,
};
/** The model request's system text: its system messages, wherever they are, in order. */
const systemText = (body: any) => body.messages.filter((message: any) => message.role === "system" || message.role === "developer")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");
const declared = (body: any) => (body.tools ?? []).map((tool: any) => tool.function.name);
const outputTool = (body: any) => (body.tools ?? []).find((tool: any) => tool.function.name === "final_output")?.function;

async function agent(r: Awaited<ReturnType<typeof runtime>>) {
  const created = await r.call("/v1/agents", { body: {} });
  assert.equal(created.status, 201, created.text);
  return created.json.id as string;
}

test("a prompt with output ends on a final_output call that fits its schema, which the outcome returns", async t => {
  const r = await runtime(t, (body, index) => [
    // The first answer does not fit: the model is told what is wrong, and answers again.
    toolCall("final_output", { sentiment: "great", score: 0.9 }, "call_1"),
    { role: "assistant", content: "Here it is.", tool_calls: toolCall("final_output", { sentiment: "positive", score: 0.9 }, "call_2").tool_calls },
    { role: "assistant", content: "unused" },
  ][index]);
  const id = await agent(r);
  const record = await r.prompt(id, "I love it", undefined, { output: { schema: { $schema: "https://json-schema.org/draft/2020-12/schema", ...SCHEMA } } });
  assert.equal(record.error, undefined, JSON.stringify(record));
  assert.deepEqual(record.outcome.result.output, { sentiment: "positive", score: 0.9 });
  assert.equal(record.outcome.result.reply, "Here it is.");
  // The model got the schema as the tool's parameters ($schema dropped), and the bad answer's errors.
  assert.deepEqual(outputTool(r.model.bodies[0]).parameters, SCHEMA);
  assert.match(toolResults(r.model.bodies[1]).at(-1), /Validation failed for tool "final_output"/);
  // The accepted call ends the turn: the model is not asked again.
  assert.equal(r.model.bodies.length, 2);
});

test("a structured run the model ends in text is reminded once, then fails with output_missing; a prompt without output takes the tool away", async t => {
  const r = await runtime(t, (_body, index) => [
    { role: "assistant", content: "It is positive." },
    { role: "assistant", content: "Still positive." },
    toolCall("final_output", { sentiment: "neutral", score: 0 }),
    { role: "assistant", content: "Plain answer." },
  ][index]);
  const id = await agent(r);
  const missing = await r.prompt(id, "How is it?", undefined, { output: { schema: SCHEMA } });
  assert.equal(missing.outcome.result.code, "output_missing");
  assert.match(missing.error, /without calling final_output/);
  assert.equal(missing.outcome.result.reply, "Still positive.");
  // The model was told to answer with the tool and, once it answered in text, asked again with a reminder:
  // its text answer taken back, so the request ends with the prompt (some providers would continue an answer).
  assert.match(systemText(r.model.bodies[0]), /<structured_output>/);
  assert.doesNotMatch(systemText(r.model.bodies[0]), /structured_output_reminder/);
  assert.match(systemText(r.model.bodies[1]), /structured_output_reminder/);
  assert.equal(r.model.bodies[1].messages.findLast((message: any) => message.role !== "system").role, "user");
  assert.equal(r.model.bodies.length, 2);
  assert.deepEqual((await r.call(`/v1/agents/${id}/history`)).json.messages.map((message: any) => message.role), ["user", "assistant"]);
  // The same schema again: the tool stays, and the reminder is taken back.
  const again = await r.prompt(id, "Again", undefined, { output: { schema: SCHEMA } });
  assert.deepEqual(again.outcome.result.output, { sentiment: "neutral", score: 0 });
  assert.ok(declared(r.model.bodies[2]).includes("final_output"));
  assert.doesNotMatch(systemText(r.model.bodies[2]).split("<structured_output>").at(-1)!, /structured_output_reminder/);
  // A plain prompt: no final_output, no output section, no output, no error.
  const plain = await r.prompt(id, "Just talk");
  assert.equal(plain.error, undefined);
  assert.equal(plain.outcome.result.output, undefined);
  assert.equal(plain.outcome.result.reply, "Plain answer.");
  assert.ok(!declared(r.model.bodies[3]).includes("final_output"));
  assert.doesNotMatch(systemText(r.model.bodies[3]), /<structured_output>/);
});

test("output is refused unless it is a schema for an object, on a prompt that starts its own turn", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const id = await agent(r);
  for (const [output, error] of [
    [{ schema: { type: "array" } }, /must describe an object/],
    [{ schema: { type: "object", properties: { a: { type: "string", pattern: "(" } } } }, /not a JSON Schema/],
    [{ schema: SCHEMA, strict: true }, /./],
    ["object", /./],
  ] as const) {
    const refused = await r.call(`/v1/agents/${id}/prompt`, { body: { text: "x", output } });
    assert.equal(refused.status, 400, refused.text);
    assert.match(refused.text, error);
  }
  const steered = await r.call(`/v1/agents/${id}/prompt`, { body: { text: "x", whileRunning: "steer", output: { schema: SCHEMA } } });
  assert.equal(steered.status, 400);
  assert.match(steered.text, /not whileRunning: steer/);
});

test("the SDK's run() takes a zod, TypeBox or JSON schema for output and types run.output by it", async t => {
  const r = await runtime(t, body => {
    const answered = body.messages.at(-1).role === "tool";
    const shape = outputTool(body)?.parameters;
    if (answered) return { role: "assistant", content: "unused" };
    // The model answers in whichever shape the run asked for.
    return toolCall("final_output", shape?.properties?.score?.type === "string" ? { sentiment: "positive", score: "0.5" } : { sentiment: "positive", score: 0.5 });
  });
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  const agent = await agents.upsert("structured");

  // zod: its input side is what the model writes, and the run's output is what it parses to.
  const Review = z.object({ sentiment: z.enum(["positive", "neutral", "negative"]), score: z.string().transform(Number) });
  const parsed = await agent.run("Rate it", { output: Review });
  const score: number = parsed.output!.score;
  assert.equal(score, 0.5);
  assert.deepEqual(parsed.output, { sentiment: "positive", score: 0.5 });

  // TypeBox, and plain JSON Schema (output: unknown).
  const typed = await agent.run("Rate it", { output: schema.Object({ sentiment: schema.Union([schema.Literal("positive"), schema.Literal("negative")]), score: schema.Number() }) });
  const sentiment: "positive" | "negative" = typed.output!.sentiment;
  assert.equal(sentiment, "positive");
  const plain = await agent.run("Rate it", { output: SCHEMA });
  assert.deepEqual(plain.output, { sentiment: "positive", score: 0.5 });

  // A zod refinement the JSON Schema cannot say fails the run on this side.
  const strict = z.object({ sentiment: z.string(), score: z.number().refine(value => value > 0.9, "too low") });
  const failed = await agent.run("Rate it", { output: strict, throwOnError: false });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "output_invalid");
  assert.match(failed.error!.message, /score: too low/);
  await assert.rejects(agent.run("Rate it", { output: strict }), RunError);

  // Without output, a run has none.
  const none = await agent.run("Hi", { throwOnError: false });
  assert.equal(none.output, undefined);
});
