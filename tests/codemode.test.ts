import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAgentHost, type HostIO } from "../src/agent-host.ts";
import type { CallContext, ToolDefinition } from "../src/protocol.ts";
import { openPiStorage } from "../src/pi-durable/storage.ts";
import { journalMessages } from "./fixtures/journal-history.ts";
import { inlineSandboxes } from "./inline-sandbox.ts";
import { PiV8Sandbox } from "../src/codemode-pi-launcher.ts";
import { existsSync } from "node:fs";
import { v8ExecBinary } from "../src/v8-exec.ts";
import type { Guest } from "../src/codemode.ts";
import type { V8Exec } from "../src/v8-exec.ts";

/**
 * Pi's code mode in the agent host: the model's `codemode` call runs a script whose `tools.<name>()` calls are Pi nested
 * calls, each sent to the supervisor as the code mode call's (`innerCallId` its key), and replayed, not made again, when
 * the agent is loaded again mid-script. The script runs on Pi's QuickJS here; the runtime suites run it on v8-exec.
 */
type Context = { after(fn: () => unknown): void };
type Call = { name: string; args: Record<string, unknown>; call?: CallContext };

async function setup(t: Context, tools: ToolDefinition[]) {
  const directory = await mkdtemp(join(tmpdir(), "codemode-"));
  const faux = registerFauxProvider({ tokensPerSecond: 1_000_000 });
  t.after(async () => { faux.unregister(); await rm(directory, { recursive: true, force: true }); });
  const calls: Call[] = [];
  async function start(answer: (call: Call) => unknown, options: { resume?: boolean; codeMode?: boolean; tools?: ToolDefinition[]; io?: Partial<HostIO>; init?: Record<string, unknown> } = {}) {
    const events: any[] = [];
    const storage = await openPiStorage({ sessionId: "agent", directory });
    const io: HostIO = {
      emit: event => events.push(event),
      tool: async (name, args, call) => { const made = { name, args, ...call ? { call } : {} }; calls.push(made); return answer(made); },
      cancelTools: async () => null,
      runLimit: async () => undefined,
      legacyLog: { empty: async () => true },
      piStorage: async () => storage,
      file: async () => { throw new Error("no files"); },
      modelAuth: async () => { throw new Error("no per-call credentials"); },
      fs: async () => { throw new Error("no files"); },
      codeSandbox: inlineSandboxes(),
      ...options.io,
    };
    const host = createAgentHost(io);
    const init = await host.handle("init", { id: "agent", directory, model: faux.getModel(), apiKey: "fixture", tools: options.tools ?? tools, ...options.codeMode === false ? { codeMode: false } : {}, ...options.resume ? { resume: true } : {}, ...options.init });
    let disposed = false;
    const dispose = async () => { if (!disposed) { disposed = true; await host.dispose(); await storage.close(BACKGROUND_CONTEXT); } };
    t.after(dispose);
    return { host, init, events, dispose };
  }
  return { faux, calls, start, respond: (...steps: FauxResponseStep[]) => faux.setResponses(steps), history: () => journalMessages({ sessionId: "agent", directory }) };
}

const answer = (content: Parameters<typeof fauxAssistantMessage>[0], stopReason: AssistantMessage["stopReason"] = "stop") => fauxAssistantMessage(content, { stopReason });
const tool = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({ name, description: `The ${name} tool`, parameters: { type: "object" }, ...extra });
const textOf = (message: any) => (message?.content ?? []).flatMap((part: any) => part.type === "text" ? [part.text] : []).join("\n");

test("a codemode script calls tools as nested calls of the model's call, gets their data, and only its result enters the history", async t => {
  const fake = await setup(t, [tool("lookup", { exposure: "codemode" }), tool("note", { exposure: "direct" }), tool("mcp__search", { resultFormat: "content", exposure: "codemode" })]);
  const { host, events } = await fake.start(call => call.name === "lookup" ? { id: call.args.id, total: 3 }
    : call.name === "mcp__search" ? { content: [{ type: "text", text: JSON.stringify({ hits: ["a", "b"] }) }] } : "noted");
  const seen: string[][] = [];
  fake.respond(context => {
    seen.push(getCurrentTools(context.messages).map(declared => declared.name).sort());
    return answer(fauxToolCall("codemode", { code: `const one = await tools.lookup({ id: 7 });
const found = await tools.mcp__search({ q: "x" });
console.log("looked up", one.id);
return { total: one.total, hits: found.hits.length, noted: await tools.note({}) };` }, { id: "code" }), "toolUse");
  }, answer("done"));
  const run = await host.handle("prompt", { text: "go" });
  assert.equal(run.error, null);
  assert.equal(run.reply, "done");
  // The model is offered code mode and the tools declared to it; a code-only tool only scripts reach.
  assert.deepEqual(seen[0], ["codemode", "note"]);
  assert.deepEqual(fake.calls.map(call => [call.name, call.call]), [
    ["lookup", { toolCallId: "code", innerCallId: "c1", messageIndex: 1 }],
    ["mcp__search", { toolCallId: "code", innerCallId: "c2", messageIndex: 1 }],
    ["note", { toolCallId: "code", innerCallId: "c3", messageIndex: 1 }],
  ]);
  const history = await fake.history();
  assert.deepEqual(history.map(message => message.role), ["user", "assistant", "toolResult", "assistant"]);
  const output = textOf(history[2]);
  assert.match(output, /^Script completed/);
  assert.match(output, /\{"total":3,"hits":2,"noted":"noted"\}/);
  assert.match(output, /<console_output>\nlooked up 7\n<\/console_output>/);
  // The stream tells of the model's call alone: a start and an end, and no nested calls.
  assert.deepEqual(events.filter(event => event.type === "tool_execution_start" || event.type === "tool_execution_end").map(event => [event.type, event.toolCallId]),
    [["tool_execution_start", "code"], ["tool_execution_end", "code"]]);
});

test("a tool's error rejects in the script, with its message; a model-only tool is not there to call", async t => {
  const fake = await setup(t, [tool("fails"), tool("control", { callers: ["model"] })]);
  const { host } = await fake.start(call => { if (call.name === "fails") throw new Error("the service said no"); return "ran"; });
  fake.respond(answer(fauxToolCall("codemode", { code: `let error;
try { await tools.fails({}); } catch (caught) { error = caught.message; }
return { error, control: ALL_TOOLS.some(entry => entry.name === "control"), listed: ALL_TOOLS.map(entry => entry.name) };` }, { id: "code" }), "toolUse"), answer("done"));
  await host.handle("prompt", { text: "go" });
  const output = textOf((await fake.history())[2]);
  assert.match(output, /"error":"the service said no"/);
  assert.match(output, /"control":false/);
  assert.match(output, /"listed":\["fails"\]/);
  assert.deepEqual(fake.calls.map(call => call.name), ["fails"]);
});

test("a script cut off by a stop resumes on the next load: finished calls are not made again, the one in flight is unknown", async t => {
  const fake = await setup(t, [tool("step")]);
  const stuck = Promise.withResolvers<void>();
  const first = await fake.start(async call => {
    if (call.args.n === 2) { stuck.resolve(); await new Promise(() => {}); }
    return `step ${call.args.n}`;
  });
  fake.respond(answer(fauxToolCall("codemode", { code: `const done = [await tools.step({ n: 1 })];
try { done.push(await tools.step({ n: 2 })); } catch (error) { done.push("failed: " + error.message); }
done.push(await tools.step({ n: 3 }));
return done;` }, { id: "code" }), "toolUse"), answer("done"));
  const running = first.host.handle("prompt", { text: "go" });
  await stuck.promise;
  await first.dispose();
  assert.deepEqual(await running, { error: null, handedOff: true });
  assert.deepEqual(fake.calls.map(call => call.args.n), [1, 2]);

  const second = await fake.start(call => `step ${call.args.n}`, { resume: true });
  assert.deepEqual(second.init.resume, { continue: true });
  const run = await second.host.handle("continue", {});
  assert.equal(run.error, null);
  assert.equal(run.reply, "done");
  // Step 1 came from the journal; step 2 had started, so it is not made again but fails as of unknown outcome.
  assert.deepEqual(fake.calls.map(call => call.args.n), [1, 2, 3]);
  const output = textOf((await fake.history()).find(message => message.role === "toolResult"));
  assert.match(output, /\["step 1","failed: [^"]*","step 3"\]/);
});

test("a js_exec call a node left open when code mode replaced it ends as interrupted, and the turn goes on", async t => {
  // The release before: js_exec was the agent's code tool. A tool of that name stands in for it here.
  const fake = await setup(t, [tool("js_exec")]);
  const stuck = Promise.withResolvers<void>();
  const first = await fake.start(async () => { stuck.resolve(); await new Promise(() => {}); });
  fake.respond(answer(fauxToolCall("js_exec", { code: "return 1" }, { id: "old" }), "toolUse"), answer("carried on"));
  const running = first.host.handle("prompt", { text: "go" });
  await stuck.promise;
  await first.dispose();
  await running;

  // This release: no js_exec. The open call ends with an error result, and the model answers.
  const made = fake.calls.length;
  const second = await fake.start(() => "unused", { resume: true, tools: [] });
  const run = await second.host.handle("continue", {});
  assert.equal(run.error, null);
  assert.equal(run.reply, "carried on");
  assert.equal(fake.calls.length, made, "nothing ran again");
  const result = (await fake.history()).find(message => message.role === "toolResult") as any;
  assert.equal(result.toolCallId, "old");
  assert.equal(result.isError, true);
});

test("codeMode false declares no codemode tool; turning it on later does", async t => {
  const fake = await setup(t, [tool("lookup", { exposure: "codemode" })]);
  const { host } = await fake.start(() => "found", { codeMode: false });
  const seen: string[][] = [];
  const record = () => (context: any) => { seen.push(getCurrentTools(context.messages).map(declared => declared.name).sort()); return answer("ok"); };
  fake.respond(record());
  await host.handle("prompt", { text: "one" });
  await host.handle("configure", { codeMode: true });
  fake.respond(record());
  await host.handle("prompt", { text: "two" });
  assert.deepEqual(seen, [["lookup"], ["codemode"]]);
});

test("a script's result text is held to maxOutputCharacters, even when its options ask for more", async t => {
  const fake = await setup(t, []);
  const { host } = await fake.start(() => null);
  fake.respond(answer(fauxToolCall("codemode", { code: `// @options: {"max_output_tokens": 1000000}
for (let i = 0; i < 100; i++) text("${"y".repeat(99)}\\n".repeat(20));
return 1;` }, { id: "code" }), "toolUse"), answer("done"));
  const run = await host.handle("prompt", { text: "go" });
  assert.equal(run.error, null);
  const output = textOf((await fake.history())[2]);
  assert.ok(output.length < 130_000, `${output.length} characters`);
  assert.match(output, /\[Result cut at 128,000 of 2\d\d,\d\d\d characters\./);
});

test("a script gets at most resultBytes from one call and totalToolBytes from all of them", async t => {
  const fake = await setup(t, [tool("blob")]);
  const { host } = await fake.start(call => "z".repeat(Number(call.args.size)));
  fake.respond(answer(fauxToolCall("codemode", { code: `const errors = [];
let got = 0;
try { await tools.blob({ size: 1100000 }); } catch (error) { errors.push(error.message); }
for (let i = 0; i < 20; i++) {
  try { got += (await tools.blob({ size: 900000 })).length; } catch (error) { errors.push(error.message); break; }
}
return { got, errors };` }, { id: "code" }), "toolUse"), answer("done"));
  const run = await host.handle("prompt", { text: "go" });
  assert.equal(run.error, null);
  const output = textOf((await fake.history())[2]);
  assert.match(output, /a script gets at most 1,047,552 from one call/);
  assert.match(output, /more than 8,388,608 bytes in all/);
  assert.match(output, /"got":8100000/);
});

test("a script stopped while it waits for the lease, or while it runs, gives back its code slot and ends its process", async t => {
  const fake = await setup(t, []);
  // The launcher as production runs it, on a process that starts and never answers.
  const guests: { ended: number }[] = [];
  const pool = { open: () => {
    const guest = { ended: 0 };
    guests.push(guest);
    let close!: (reason: string) => void;
    return { dispatched: true, send: () => {}, listen: (_message, closed) => { close = closed; }, end: () => { guest.ended++; close("ended"); } } satisfies Guest;
  } } as unknown as V8Exec;
  let lease = Promise.withResolvers<void>(), slots = 0, released = 0;
  const { host } = await fake.start(() => null, { io: {
    lease: () => lease.promise,
    codeSlot: async () => { slots++; return () => { released++; }; },
    codeSandbox: options => new PiV8Sandbox({ ...options, pool }),
  } });
  const script = () => answer(fauxToolCall("codemode", { code: "return 1" }, { id: `code-${Math.random()}` }), "toolUse");
  // The model's request waits for the lease too: it is fresh for that, and stale again before the script is admitted.
  fake.respond(() => { lease = Promise.withResolvers<void>(); return script(); }, answer("done"));
  lease.resolve();
  const waiting = host.handle("prompt", { text: "go" });
  await new Promise(resolve => setTimeout(resolve, 50));
  await host.handle("abort", {});
  await waiting;
  assert.deepEqual({ slots, released, guests: guests.length }, { slots: 0, released: 0, guests: 0 });
  lease.resolve();
  fake.respond(script(), answer("done"));
  const running = host.handle("prompt", { text: "again" });
  while (!guests.length) await new Promise(resolve => setTimeout(resolve, 5));
  await host.handle("abort", {});
  await running;
  assert.deepEqual({ slots, released, ended: guests.map(guest => guest.ended) }, { slots: 1, released: 1, ended: [1] });
});

test("a script's cut output and its images are saved in the workspace, and code mode's description says where", async t => {
  const fake = await setup(t, []);
  const written: { path: string; text?: string; base64?: string }[] = [];
  const { host } = await fake.start(() => null, { init: { mounts: [{ path: "/workspace", mode: "rw", workspace: true }] },
    io: { fs: async (op, args) => { assert.equal(op, "writeFile"); written.push(args as never); return {}; } } });
  const seen: string[] = [];
  fake.respond(context => {
    seen.push(getCurrentTools(context.messages).find(declared => declared.name === "codemode")!.description);
    return answer(fauxToolCall("codemode", { code: `image("data:image/png;base64,iVBORw0KGgo=");
for (let i = 0; i < 1000; i++) console.log("${"w".repeat(99)}");
return 1;` }, { id: "code" }), "toolUse");
  }, answer("done"));
  const run = await host.handle("prompt", { text: "go" });
  assert.equal(run.error, null);
  assert.match(seen[0], /in a JavaScript sandbox:/);
  assert.match(seen[0], /\n\nWrite and edit files with the write and edit tools directly, not from a script\.$/);
  assert.match(seen[0], /saves the image in your workspace \(tool-results\/\)/);
  assert.doesNotMatch(seen[0], /QuickJS|temp file/);
  const output = textOf((await fake.history())[2]);
  const [image, whole] = [written.find(file => file.path.endsWith("/image-1.png")), written.find(file => file.path.endsWith("/output.txt"))];
  assert.match(image!.path, /^\/workspace\/tool-results\/pi-codemode-[0-9a-f]{8}\/image-1\.png$/);
  assert.equal(image!.base64, "iVBORw0KGgo=");
  assert.equal(whole!.text!.split("\n").filter(line => /^w{99}$/.test(line)).length, 1000);
  assert.ok(output.includes(`[Image saved to ${image!.path}`) && output.includes(`[Full output: ${whole!.path}`), output.slice(0, 500));
});

test("two turns' code mode calls with the same id each give their calls their own history position", async t => {
  const fake = await setup(t, [tool("lookup")]);
  const { host } = await fake.start(() => "found");
  for (const text of ["one", "two"]) {
    fake.respond(answer(fauxToolCall("codemode", { code: "return await tools.lookup({});" }, { id: "call_0" }), "toolUse"), answer("done"));
    assert.equal((await host.handle("prompt", { text })).error, null);
  }
  const positions = fake.calls.map(call => call.call?.messageIndex);
  assert.equal(positions.length, 2);
  assert.notEqual(positions[0], positions[1], JSON.stringify(positions));
});

test("a tool error too large for a script rejects only that call, its message cut", { skip: !existsSync(v8ExecBinary()) && "v8-exec is not built" }, async t => {
  const fake = await setup(t, [tool("fails")]);
  // On v8-exec, whose bridge takes a result of at most SANDBOX_LIMITS.resultBytes.
  const { host } = await fake.start(() => { throw new Error("e".repeat(2 * 1024 * 1024)); }, { io: { codeSandbox: options => new PiV8Sandbox(options) } });
  fake.respond(answer(fauxToolCall("codemode", { code: `try { await tools.fails({}); } catch (error) { return { length: error.message.length, cut: /Error cut at 65,536/.test(error.message) }; }` }, { id: "code" }), "toolUse"), answer("done"));
  assert.equal((await host.handle("prompt", { text: "go" })).error, null);
  const output = textOf((await fake.history())[2]);
  assert.match(output, /"cut":true/);
  assert.match(output, /^Script completed/);
});
