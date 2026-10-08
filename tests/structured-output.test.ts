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

const forced = { type: "function", function: { name: "final_output" } };

test("a structured run forces final_output from the first request when it is the model's only tool, and on the reminder when it has others", async t => {
  const r = await runtime(t, body => {
    // A model that answers in text unless the request forces the tool.
    if (body.tool_choice) return toolCall("final_output", { sentiment: "positive", score: 1 });
    return { role: "assistant", content: "Positive." };
  });
  // No js_exec, no file tools, no tools of any source: final_output is the only tool.
  const bare = (await r.call("/v1/agents", { body: { codeMode: false, fileTools: false, systemPrompt: "Reply with one line of text." } })).json.id as string;
  const record = await r.prompt(bare, "I love it", undefined, { output: { schema: SCHEMA } });
  assert.deepEqual(record.outcome.result.output, { sentiment: "positive", score: 1 }, JSON.stringify(record));
  assert.deepEqual(declared(r.model.bodies[0]), ["final_output"]);
  assert.deepEqual(r.model.bodies[0].tool_choice, forced);
  assert.equal(r.model.bodies.length, 1);
  // A plain run of the same agent: no tools, nothing forced.
  assert.equal((await r.prompt(bare, "Hello")).outcome.result.reply, "Positive.");
  assert.equal(r.model.bodies[1].tool_choice, undefined);
  assert.deepEqual(declared(r.model.bodies[1]), []);

  // With js_exec too: the first request is free to use it; once the model answers in text, the reminder forces the tool.
  const coded = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const reminded = await r.prompt(coded, "I love it", undefined, { output: { schema: SCHEMA } });
  assert.deepEqual(reminded.outcome.result.output, { sentiment: "positive", score: 1 });
  assert.equal(r.model.bodies[2].tool_choice, undefined);
  assert.ok(declared(r.model.bodies[2]).includes("js_exec"));
  assert.deepEqual(r.model.bodies[3].tool_choice, forced);
  assert.match(systemText(r.model.bodies[3]), /structured_output_reminder/);
});

test("a provider that refuses a forced tool_choice is asked again without it; forcing stops after three requests", async t => {
  const r = await runtime(t, body => {
    if (body.tool_choice) return { httpStatus: 400, message: "tool_choice is not supported" };
    return toolCall("final_output", { sentiment: "neutral", score: 0 });
  });
  const id = (await r.call("/v1/agents", { body: { codeMode: false, fileTools: false } })).json.id as string;
  const record = await r.prompt(id, "How is it?", undefined, { output: { schema: SCHEMA } });
  assert.deepEqual(record.outcome.result.output, { sentiment: "neutral", score: 0 }, JSON.stringify(record));
  assert.deepEqual(r.model.bodies.map(body => !!body.tool_choice), [true, false]);
  assert.deepEqual((await r.call(`/v1/agents/${id}/history`)).json.messages.map((message: any) => message.role), ["user", "assistant", "toolResult"]);

  // A model whose forced calls never fit the schema: three forced requests, then it may end its turn.
  const r2 = await runtime(t, body => body.tool_choice ? toolCall("final_output", { sentiment: "great" }, `call_${Math.random()}`) : { role: "assistant", content: "Fine." });
  const other = (await r2.call("/v1/agents", { body: { codeMode: false, fileTools: false } })).json.id as string;
  const missing = await r2.prompt(other, "How is it?", undefined, { output: { schema: SCHEMA } });
  assert.equal(missing.outcome.result.code, "output_missing");
  assert.deepEqual(r2.model.bodies.map(body => !!body.tool_choice), [true, true, true, false, false]);
});

test("codeMode: false leaves out js_exec and the runtime's code rules; with no tools at all, the prompt is the instructions and the sender note", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "yes" }));
  const instructions = "Answer yes or no.";
  const made = async (body: object) => (await r.call("/v1/agents", { body: { systemPrompt: instructions, ...body } })).json.id as string;
  const bare = await made({ codeMode: false, fileTools: false });
  const direct = await made({ codeMode: false });
  const coded = await made({});
  for (const id of [bare, direct, coded]) await r.prompt(id, "Is water wet?");
  const [bareBody, directBody, codedBody] = r.model.bodies;
  assert.deepEqual(declared(bareBody), []);
  assert.doesNotMatch(systemText(bareBody), /js_exec|Your environment|present_file|Tools:/);
  assert.match(systemText(bareBody), /Answer yes or no\./);
  assert.match(systemText(bareBody), /Message context:/);
  // File tools, declared directly; the rules for tools and files, nothing about code.
  assert.ok(declared(directBody).includes("present_file") && declared(directBody).includes("read"), declared(directBody).join());
  assert.ok(!declared(directBody).includes("js_exec"));
  assert.doesNotMatch(systemText(directBody), /js_exec/);
  assert.match(systemText(directBody), /Call your tools directly/);
  assert.ok(declared(codedBody).includes("js_exec"));
  // What each costs: the request's system text and tools, in characters (about four to a token).
  const size = (body: any) => systemText(body).length + JSON.stringify(body.tools ?? []).length;
  assert.ok(size(bareBody) < 1_500, `bare: ${size(bareBody)}`);
  assert.ok(size(codedBody) > 4 * size(bareBody), `coded ${size(codedBody)} vs bare ${size(bareBody)}`);
  const detail = (await r.call(`/v1/agents/${bare}`)).json;
  assert.equal(detail.codeMode, false);
  // An upsert can turn it back on: js_exec returns.
  const keyed = await r.call("/v1/agents", { body: { codeMode: false }, headers: { "Idempotency-Key": "coded-later" } });
  const changed = await r.call("/v1/agents", { body: {}, headers: { "Idempotency-Key": "coded-later" } });
  assert.notEqual(changed.json.configHash, keyed.json.configHash);
  await r.prompt(keyed.json.id, "Is it?");
  assert.ok(declared(r.model.bodies.at(-1)).includes("js_exec"));
});
