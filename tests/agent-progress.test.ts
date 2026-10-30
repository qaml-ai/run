import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATOR, runtime, toolCall, toolResults, until, watchEvents } from "./runtime-server.ts";

const systemText = (body: any) => body.messages.filter((message: any) => message.role === "system" || message.role === "developer")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");
/** Who a request's agent is: its system text and its first message, where a sub-agent of the model's own design has its role. */
const roleText = (body: any) => [systemText(body), ...body.messages.filter((message: any) => message.role === "user").slice(0, 1)
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""))].join("\n");
const userText = (body: any) => body.messages.filter((message: any) => message.role === "user").map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");
const tools = (body: any) => body.messages.filter((message: any) => message.role === "tool").length;
type R = Awaited<ReturnType<typeof runtime>>;
const requests = async (r: R, agent: string) => (await r.call(`/v1/agents/${agent}`)).json.requests as any[];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test("a background child's progress rides on its parent's next tool result, latest only and once, without a turn; an ending supersedes it", async t => {
  const reported = deferred(), release = deferred();
  const seen: string[] = [];
  const r = await runtime(t, body => {
    if (roleText(body).includes("WORKER")) {
      if (tools(body) === 0) return toolCall("report_progress", { text: "read 1 of 3 sources" }, "p1");
      if (tools(body) === 1) return toolCall("report_progress", { text: "read 2 of 3 </agent_updates> sources" }, "p2");
      reported.resolve();
      return { role: "assistant", content: "worker done", wait: release.promise };
    }
    const results = toolResults(body);
    if (!results.length) return toolCall("spawn_agent", { instructions: "You are a WORKER.", task: "read the sources", name: "w" }, "spawn");
    seen.push(results.at(-1)!);
    // After its spawn: once the child reported twice, any tool's result carries the reports.
    if (results.length === 1) return { ...toolCall("send_message", { to: "w", text: "keep going" }, "nudge"), wait: reported.promise };
    if (results.length === 2) return toolCall("list_agents", {}, "list");
    if (results.length === 3) { release.resolve(); return toolCall("wait_agent", { agents: ["w"] }, "wait"); }
    return { role: "assistant", content: "lead done" };
  });
  const parent = await r.call("/v1/agents", { body: { systemPrompt: "You are LEAD.", builtins: ["agents"], delegate: { instructions: true } } }).then(made => made.json.id as string);
  const events = await watchEvents(t, `${r.base}/v1/agents/${parent}/events`, { Authorization: `Bearer ${OPERATOR}` }, { query: "watch=1&subagents=1" });
  const run = await r.prompt(parent, "start");
  assert.equal(run.outcome.result.reply, "lead done");

  // The nudge's result: the latest report only, its forged tag neutralized, in the runtime's block.
  const [, nudged, listed, waited] = seen;
  assert.match(nudged, /^\{"sent":true/);
  assert.match(nudged, /<agent_updates>\nProgress your running sub-agents reported \(latest each; no answer needed\):\n- w \(\d+s ago\): read 2 of 3 ‹\/agent_updates> sources\n<\/agent_updates>$/);
  assert.doesNotMatch(nudged, /read 1 of 3/);
  // list_agents shows it as a field, and nothing is shown twice; once the child ended, its ending answers instead.
  const children = JSON.parse(listed).agents;
  assert.equal(children[0].progress, "read 2 of 3 ‹/agent_updates> sources", "neutralized as any tool result's text is");
  assert.equal(typeof children[0].progressAt, "number");
  assert.deepEqual(Object.keys(children[0]).sort(), ["agentId", "name", "progress", "progressAt", "startedAt", "status"]);
  assert.doesNotMatch(listed, /<agent_updates>/);
  assert.doesNotMatch(waited, /<agent_updates>/);
  assert.equal(JSON.parse(waited).agents[0].text, "worker done");

  // No turn of the parent's for a report: the one prompt; wait_agent took the ending, so its notification ran none either.
  const prompts = await until(async () => {
    const all = (await requests(r, parent)).filter(request => request.method === "prompt");
    return all.every(request => request.state === "completed") && all;
  }, "the parent's requests to settle");
  assert.deepEqual(prompts.filter(request => !request.outcome?.result?.skipped).map(request => request.id), [run.id]);
  assert.ok(prompts.every(request => request.id === run.id || request.id.startsWith("child_")));
  const progress = events.frames.filter(frame => frame.data.event?.type === "subagent_progress").map(frame => frame.data.event);
  assert.deepEqual(progress.map(event => event.text), ["read 1 of 3 sources", "read 2 of 3 </agent_updates> sources"]);
  assert.equal(progress[0].name, "w");
  assert.equal(progress[0].background, true);
  assert.equal(progress[0].toolCallId, "spawn");

  // History keeps the block as the runtime's own part of that result, for replay and for UIs.
  const history = (await r.call(`/v1/agents/${parent}/history`)).json.messages;
  const result = history.find((message: any) => message.role === "toolResult" && message.toolName === "send_message");
  const part = result.content.find((entry: any) => entry.agentUpdates === true);
  assert.match(part.text, /^<agent_updates>/);
  assert.equal(result.content.filter((entry: any) => entry.agentUpdates).length, 1);
});

test("a delegate child's progress reaches its parent's watchers as subagent_progress and the delegate call's progress", async t => {
  const r = await runtime(t, body => {
    if (roleText(body).includes("WORKER")) return tools(body) === 0 ? toolCall("report_progress", { text: "halfway" }, "p1") : { role: "assistant", content: "answer" };
    return tools(body) === 0 ? toolCall("delegate", { instructions: "You are a WORKER.", task: "work" }, "call_delegate") : { role: "assistant", content: "ok" };
  });
  const parent = await r.call("/v1/agents", { body: { systemPrompt: "You are LEAD.", builtins: ["delegate"], delegate: { instructions: true } } }).then(made => made.json.id as string);
  const events = await watchEvents(t, `${r.base}/v1/agents/${parent}/events`, { Authorization: `Bearer ${OPERATOR}` }, { query: "watch=1&subagents=1" });
  await r.prompt(parent, "go");
  const progress = await until(() => events.frames.find(frame => frame.data.event?.type === "subagent_progress")?.data.event, "subagent_progress");
  assert.equal(progress.text, "halfway");
  assert.equal(progress.toolCallId, "call_delegate");
  assert.equal(progress.background, undefined);
  const update = events.frames.find(frame => frame.data.event?.type === "tool_execution_update" && frame.data.event.toolCallId === "call_delegate")?.data.event;
  assert.deepEqual(update.partialResult.details, { type: "progress", tool: "delegate", message: "halfway" });
});

test("only a sub-agent reports progress, and a report is short", async t => {
  const r = await runtime(t, body => {
    if (roleText(body).includes("WORKER")) {
      return tools(body) === 0 ? toolCall("report_progress", { text: "x".repeat(501) }, "long") : { role: "assistant", content: toolResults(body).at(-1)! };
    }
    return tools(body) === 0 ? toolCall("delegate", { instructions: "You are a WORKER.", task: "work" }, "call_delegate") : { role: "assistant", content: toolResults(body).at(-1)! };
  });
  const top = await r.call("/v1/agents", { body: { systemPrompt: "You are LEAD." } }).then(made => made.json.id as string);
  const listed = (await r.call(`/v1/agents/${top}`)).json;
  assert.ok(Array.isArray(listed.toolSources));
  assert.doesNotMatch(JSON.stringify(listed.toolSources), /report_progress/, "an agent no one started has no parent to report to");
  const parent = await r.call("/v1/agents", { body: { systemPrompt: "You are LEAD.", builtins: ["delegate"], delegate: { instructions: true } } }).then(made => made.json.id as string);
  const run = await r.prompt(parent, "go");
  assert.match(run.outcome.result.reply, /report_progress[\s\S]*must not have more than 500 characters/);
});

const lastUserText = (body: any) => { const message = body.messages.findLast((entry: any) => entry.role === "user"); return typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""); };

test("a child's message joins its busy parent's running turn at its next step, without a turn of its own", async t => {
  const sent = deferred(), release = deferred();
  const bodies: any[] = [];
  const r = await runtime(t, body => {
    if (roleText(body).includes("WORKER")) {
      if (tools(body) === 0) return toolCall("send_message", { to: "parent", text: "found the bug" }, "m1");
      sent.resolve();
      return { role: "assistant", content: "worker done", wait: release.promise };
    }
    bodies.push(body);
    const results = toolResults(body);
    if (!results.length) return toolCall("spawn_agent", { instructions: "You are a WORKER.", task: "find it", name: "w" }, "spawn");
    if (results.length === 1) return { ...toolCall("list_agents", {}, "l1"), wait: sent.promise };
    if (results.length === 2) { release.resolve(); return toolCall("wait_agent", { agents: ["w"] }, "wait"); }
    return { role: "assistant", content: "lead done" };
  });
  const parent = await r.call("/v1/agents", { body: { systemPrompt: "You are LEAD.", builtins: ["agents"], delegate: { instructions: true } } }).then(made => made.json.id as string);
  const events = await watchEvents(t, `${r.base}/v1/agents/${parent}/events`, { Authorization: `Bearer ${OPERATOR}` }, { query: "watch=1&subagents=1" });
  const run = await r.prompt(parent, "start");
  assert.equal(run.outcome.result.reply, "lead done");
  // The model read it in the same turn, after list_agents' result.
  const read = bodies.findIndex(body => lastUserText(body).startsWith("<agent_message"));
  assert.ok(read > 0, "the message reached the running turn");
  assert.equal(lastUserText(bodies[read]), '<agent_message name="w">\nfound the bug\n</agent_message>');
  assert.equal(toolResults(bodies[read]).length, 2);
  const message = await until(async () => (await requests(r, parent)).find(request => request.id.startsWith("msg_") && request.state === "completed"), "the message's request");
  assert.equal(message.steeredInto, run.id);
  const event = await until(() => events.frames.find(frame => frame.data.event?.type === "subagent_message")?.data, "subagent_message");
  assert.equal(event.requestId, run.id);
  assert.equal(event.event.text, "found the bug");
});

test("a child's message cuts its parent's wait_agent short, and the parent reads it next", async t => {
  const release = deferred();
  const bodies: any[] = [];
  const r = await runtime(t, body => {
    if (roleText(body).includes("WORKER")) {
      return tools(body) === 0 ? toolCall("send_message", { to: "parent", text: "need the staging URL" }, "m1") : { role: "assistant", content: "worker done", wait: release.promise };
    }
    bodies.push(body);
    const results = toolResults(body);
    if (!results.length) return toolCall("spawn_agent", { instructions: "You are a WORKER.", task: "deploy", name: "w" }, "spawn");
    if (results.length === 1) return toolCall("wait_agent", { timeoutMs: 600_000 }, "wait1");
    if (results.length === 2) { release.resolve(); return toolCall("wait_agent", {}, "wait2"); }
    return { role: "assistant", content: "lead done" };
  });
  const parent = await r.call("/v1/agents", { body: { systemPrompt: "You are LEAD.", builtins: ["agents"], delegate: { instructions: true } } }).then(made => made.json.id as string);
  const started = Date.now();
  const run = await r.prompt(parent, "start");
  assert.equal(run.outcome.result.reply, "lead done");
  assert.ok(Date.now() - started < 60_000, "the first wait did not run to its timeout");
  const first = JSON.parse(toolResults(bodies[2])[1]);
  assert.deepEqual(first.messaged, ["w"]);
  assert.equal(first.agents[0].status, "running");
  assert.match(first.message, /w sent you a message, which follows this result/);
  assert.equal(lastUserText(bodies[2]), '<agent_message name="w">\nneed the staging URL\n</agent_message>');
  assert.equal(JSON.parse(toolResults(bodies[3])[2]).agents[0].text, "worker done");
});

test("a response that starts a sub-agent and, beside it, messages and waits for it: those calls run once it has started", async t => {
  // The worker's first answer waits until its turn has the message, so the turn cannot end before it arrives (a message
  // that arrives after the turn has ended runs as a turn of its own: right, but not what this test is about).
  const heard = deferred();
  const r = await runtime(t, body => {
    if (roleText(body).includes("WORKER")) return tools(body) === 0 ? { wait: heard.promise, ...toolCall("report_progress", { text: "on it" }, "p1") } : { role: "assistant", content: `worker done; heard: ${body.messages.filter((message: any) => message.role === "user").length > 1}` };
    if (tools(body)) return { role: "assistant", content: toolResults(body).join("\n") };
    const call = (id: string, name: string, args: object, index: number) => ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
    return { role: "assistant", tool_calls: [
      call("spawn", "spawn_agent", { instructions: "You are a WORKER.", task: "work", name: "w" }, 0),
      call("say", "send_message", { to: "w", text: "also do X" }, 1),
      call("wait", "wait_agent", { agents: ["w"] }, 2),
    ] };
  });
  const parent = await r.call("/v1/agents", { body: { systemPrompt: "You are LEAD.", builtins: ["agents"], delegate: { instructions: true } } }).then(made => made.json.id as string);
  const run = r.prompt(parent, "go");
  const child = await until(async () => ((await r.call("/v1/agents")).json as any[]).find(agent => agent.parentAgentId === parent)?.id as string, "the worker");
  await until(async () => (await requests(r, child)).some(request => request.steer === "accepted" || request.steeredInto), "the message accepted into its turn");
  heard.resolve();
  const reply = (await run).outcome.result.reply as string;
  const [spawned, said, waited] = reply.split("\n").map(line => JSON.parse(line));
  assert.equal(spawned.name, "w");
  assert.equal(said.sent, true);
  assert.equal(waited.agents[0].status, "completed");
  assert.equal(waited.agents[0].text, "worker done; heard: true", "the message joined its first turn, not one after it");
});

test("a message to a sub-agent that already answered starts a turn, and wait_agent waits for that turn's answer, not the earlier one", async t => {
  const answered = deferred();
  const r = await runtime(t, body => {
    if (roleText(body).includes("WORKER")) return { role: "assistant", content: body.messages.filter((message: any) => message.role === "user").length > 1 ? "second answer" : "first answer" };
    const results = toolResults(body);
    if (!results.length) return toolCall("spawn_agent", { instructions: "You are a WORKER.", task: "work", name: "w" }, "spawn");
    // The worker has answered (its ending not taken yet) when the parent messages it.
    if (results.length === 1) return { wait: answered.promise, ...toolCall("send_message", { to: "w", text: "redo it" }, "say") };
    if (results.length === 2) return toolCall("wait_agent", { agents: ["w"] }, "wait");
    return { role: "assistant", content: results.at(-1) };
  });
  const parent = await r.call("/v1/agents", { body: { systemPrompt: "You are LEAD.", builtins: ["agents"], delegate: { instructions: true } } }).then(made => made.json.id as string);
  const run = r.prompt(parent, "go");
  const child = await until(async () => ((await r.call("/v1/agents")).json as any[]).find(agent => agent.parentAgentId === parent)?.id as string, "the worker");
  await until(async () => (await requests(r, child)).some(request => request.state === "completed"), "the worker's first answer");
  answered.resolve();
  const waited = JSON.parse((await run).outcome.result.reply as string);
  assert.equal(waited.agents.length, 1);
  assert.equal(waited.agents[0].status, "completed");
  assert.equal(waited.agents[0].text, "second answer");
});

test("a sub-agent of the model's own design gets its instructions with its task, as its first message; one from a definition keeps its own prompt", async t => {
  const { SUBAGENT_PROMPT } = await import("../src/multi-agent.ts");
  const first = new Map<string, string>();
  const r = await runtime(t, body => {
    const system = systemText(body);
    if (system.includes(SUBAGENT_PROMPT) || system.includes("DEFINED")) {
      first.set(system.includes("DEFINED") ? "defined" : "own", userText(body));
      return { role: "assistant", content: "done" };
    }
    const results = toolResults(body);
    if (!results.length) return { role: "assistant", tool_calls: [
      { index: 0, id: "a", type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ instructions: "You are a WORKER.", task: "work", name: "own" }) } },
      { index: 1, id: "b", type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ agent: "defined", task: "work", name: "def" }) } },
    ] };
    if (results.length < 4) return toolCall("wait_agent", {}, `wait${results.length}`);
    return { role: "assistant", content: "lead done" };
  });
  const defined = (await r.call("/v1/definitions", { body: { name: "Defined", systemPrompt: "You are DEFINED." } })).json.id as string;
  const parent = await r.call("/v1/agents", { body: { systemPrompt: "You are LEAD.", builtins: ["agents"], delegate: { agents: [{ name: "defined", definition: defined }], instructions: true } } }).then(made => made.json.id as string);
  await r.prompt(parent, "go");
  const children = ((await r.call("/v1/agents")).json as any[]).filter(agent => agent.parentAgentId === parent);
  const prompts = await Promise.all(children.map(async child => (await r.call(`/v1/agents/${child.id}`)).json.systemPrompt as string | undefined));
  assert.equal(prompts.filter(prompt => prompt === SUBAGENT_PROMPT).length, 1, JSON.stringify(prompts));
  assert.match(first.get("own")!, /Your role:\nYou are a WORKER\.\n\nYour task:\nwork/);
  assert.doesNotMatch(first.get("defined")!, /Your role:/, "a definition's sub-agent gets its task alone");
});

test("a sub-agent of the model's own design reads its parent's files at the same paths; files: write shares them, none keeps them apart", async t => {
  const { VolumeService } = await import("../src/volumes.ts");
  const r = await runtime(t, body => {
    if (roleText(body).includes("WORKER")) {
      const done = toolResults(body);
      const steps = [["read", { path: "/workspace/rows.txt" }], ["write", { path: "/workspace/from-child.txt", content: "child" }], ["write", { path: "/scratch/own.txt", content: "own" }]] as const;
      if (done.length < steps.length) return toolCall(steps[done.length][0], steps[done.length][1], `w${done.length}`);
      return { role: "assistant", content: done.map(result => result.slice(0, 300)).join(" | ") };
    }
    if (tools(body)) return { role: "assistant", content: JSON.parse(toolResults(body).at(-1)!).text };
    return toolCall("delegate", { instructions: "You are a WORKER.", task: "read the rows" }, "d");
  });
  const run = async (files?: string) => {
    const parent = (await r.call("/v1/agents", { body: { builtins: ["delegate"], delegate: { instructions: true, ...files ? { files } : {} } } })).json.id as string;
    const workspace = VolumeService.workspaceOf(parent);
    assert.ok((await fetch(`${r.base}/v1/volumes/${workspace}/files/rows.txt`, { method: "PUT", headers: { Authorization: `Bearer ${OPERATOR}` }, body: "east,1350" })).ok);
    const reply = (await r.prompt(parent, "go")).outcome.result.reply as string;
    const wrote = (await r.call(`/v1/volumes/${workspace}/files/from-child.txt`)).status === 200;
    return { reply: reply.split(" | "), wrote };
  };
  const read = await run();
  assert.match(read.reply[0], /east,1350/, "it reads the parent's file at the parent's path");
  assert.match(read.reply[1], /read-only/);
  assert.doesNotMatch(read.reply[2], /error|not inside|read-only/i, "it writes its own files under /scratch");
  assert.equal(read.wrote, false);
  const shared = await run("write");
  assert.match(shared.reply[0], /east,1350/);
  assert.equal(shared.wrote, true, "with files: write it writes the parent's files");
  const apart = await run("none");
  assert.doesNotMatch(apart.reply[0], /east,1350/, "with files: none the parent's files are not there");
  assert.equal(apart.wrote, false);
});

test("wait_agent with untilProgress returns on a report it has not seen, after its floor, so the parent can correct a sub-agent mid-run", async t => {
  const release = deferred();
  const bodies: any[] = [];
  let waitStarted = 0, waitEnded = 0;
  const r = await runtime(t, body => {
    if (roleText(body).includes("WORKER")) {
      if (tools(body) === 0) return toolCall("report_progress", { text: "fetching the 2019 report" }, "p1");
      if (tools(body) === 1) return { role: "assistant", content: "x", wait: release.promise, ...toolCall("report_progress", { text: "still on 2019" }, "p2") };
      const corrected = body.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("use 2025"));
      return { role: "assistant", content: corrected ? "used 2025" : "used 2019" };
    }
    bodies.push(body);
    const results = toolResults(body);
    if (!results.length) return toolCall("spawn_agent", { instructions: "You are a WORKER.", task: "get the report", name: "w" }, "spawn");
    if (results.length === 1) { waitStarted = Date.now(); return toolCall("wait_agent", { untilProgress: true, timeoutMs: 120_000 }, "watch"); }
    if (results.length === 2) { waitEnded = Date.now(); release.resolve(); return toolCall("send_message", { to: "w", text: "wrong year: use 2025" }, "fix"); }
    if (results.length === 3) return toolCall("wait_agent", {}, "wait");
    return { role: "assistant", content: "lead done" };
  }, { AGENT_PROGRESS_WAIT_MS: "1000" });
  const parent = await r.call("/v1/agents", { body: { systemPrompt: "You are LEAD.", builtins: ["agents"], delegate: { instructions: true } } }).then(made => made.json.id as string);
  const run = await r.prompt(parent, "start");
  assert.equal(run.outcome.result.reply, "lead done");
  const watched = JSON.parse(toolResults(bodies[2])[1]);
  assert.deepEqual(watched.updated, ["w"]);
  assert.equal(watched.agents[0].status, "running");
  assert.equal(watched.agents[0].progress, "fetching the 2019 report");
  assert.ok(waitEnded - waitStarted >= 900 && waitEnded - waitStarted < 30_000, `it waited its floor and no more (${waitEnded - waitStarted} ms)`);
  assert.doesNotMatch(toolResults(bodies[2])[1], /<agent_updates>/, "what it answered is not repeated");
  assert.equal(JSON.parse(toolResults(bodies[4])[3]).agents[0].text, "used 2025", "the correction reached it while it worked");
});
