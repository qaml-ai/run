import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { fakeModel } from "../../../tests/runtime-server.ts";
import { callFixture, eventually } from "./voice-call-fixture.ts";

test("OpenAI brokers SDP, journals speech without a run, meters raw cost once, and hangs up", { timeout: 90_000 }, async t => {
  const hangups: string[] = [], offers: string[] = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part);
    if (request.url === "/realtime/calls") {
      offers.push(Buffer.concat(parts).toString());
      response.writeHead(201, { Location: `/realtime/calls/provider-${offers.length}` }).end("sdp-answer");
    } else {
      hangups.push(request.url!);
      response.writeHead(204).end();
    }
  }).listen(0, "127.0.0.1");
  const sockets = new WebSocketServer({ server });
  t.after(() => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  });
  await once(server, "listening");
  const releaseLate = Promise.withResolvers<void>();
  const releaseTimeout = Promise.withResolvers<void>();
  t.after(() => { releaseLate.resolve(); releaseTimeout.resolve(); });
  const model = await fakeModel(t, (_body, index) => index === 0
    ? { role: "assistant", content: "You asked: What did I say?" }
    : { role: "assistant", content: "This is the eventual reply.", wait: index === 1 ? releaseLate.promise : releaseTimeout.promise });
  const f = await callFixture(t, `http://127.0.0.1:${(server.address() as { port: number }).port}`, { TEST_VOICE_CREDITS: "1" }, model.url);
  await f.db.query("create table voice_test_debits(key text primary key, usd double precision not null)");
  const denied = await f.create({ provider: "openai", sdp: "sdp-offer", subject: "empty" });
  assert.equal(denied.status, 402, JSON.stringify(denied.json));
  assert.equal(denied.json.code, "END_USER_CREDIT");
  assert.equal((await f.request("/v1/voice/sessions", "POST", { discord: {} })).status, 404);

  const connecting = once(sockets, "connection");
  const created = await f.create({ provider: "openai", sdp: "sdp-offer" });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const call = created.json;
  const path = `/v1/voice/sessions/${call.id}`;
  const [sideband] = await connecting;
  assert.deepEqual(call.connect, { sdpAnswer: "sdp-answer" });
  assert.match(offers[0], /sdp-offer/);
  const limited = await f.create({ provider: "openai", sdp: "sdp-offer" });
  assert.equal(limited.json.code, "VOICE_SESSION_LIMIT");
  assert.equal((await f.request(path + "/transcript", "POST", { speaker: "a", text: "override" })).json.code, "VOICE_TRANSCRIPT_SIDEBAND");

  const send = (event: object) => sideband.send(JSON.stringify(event));
  send({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "Remember the blue house", usage: { type: "duration", seconds: 2 } });
  const message = await eventually(async () => {
    const history = await f.request(`/v1/agents/${f.input.agent}/history`);
    return history.json.messages?.find((entry: { content?: string }) => entry.content === `[Voice call ${call.id}, unlabeled] Remember the blue house`);
  });
  assert.equal(message.metadata.via, "voice");
  await f.db.query("insert into end_users(tenant,id,created_at,updated_at) values($1,$2,0,0)", ["camelrun-proto-local", f.input.subject]);
  const frames: any[] = [];
  sideband.on("message", (frame: Buffer) => frames.push(JSON.parse(frame.toString())));
  const output = once(sideband, "message");
  send({ type: "response.function_call_arguments.done", call_id: "ask-1", response_id: "ask-response", name: "ask_agent",
    arguments: JSON.stringify({ request: "What did I say?" }) });
  const [frame] = await output;
  const reply = JSON.parse(frame.toString());
  assert.equal(reply.type, "conversation.item.create");
  assert.match(JSON.parse(reply.item.output).reply, /What did I say/);
  const history = (await f.request(`/v1/agents/${f.input.agent}/history`)).json.messages;
  assert.ok(history.some((entry: { content?: string }) => JSON.stringify(entry.content).includes("What was said in the call since your last request")));
  const ask = (id: string, request: string) => send({ type: "response.function_call_arguments.done",
    call_id: id, response_id: id + "-response", name: "ask_agent", arguments: JSON.stringify({ request }) });
  const alarm = (kind: string) => f.request(`/__test/voice-alarm?id=${call.id}&kind=${kind}`, "POST");
  ask("slow-ask", "Please wait for the answer");
  await eventually(async () => model.bodies.length === 2);
  assert.equal((await alarm("pending")).status, 200);
  const pending = await eventually(async () => frames.find(frame => frame.item?.call_id === "slow-ask"));
  assert.match(JSON.parse(pending.item.output).pending, /still working/);
  releaseLate.resolve();
  const late = await eventually(async () => frames.find(frame => frame.item?.content?.[0]?.text?.includes("eventual reply")));
  assert.match(late.item.content[0].text, /late reply/);
  ask("timeout-ask", "Time out this answer");
  await eventually(async () => model.bodies.length === 3);
  assert.equal((await alarm("pending")).status, 200);
  await eventually(async () => frames.find(frame => frame.item?.call_id === "timeout-ask"));
  assert.equal((await alarm("late")).status, 200);
  releaseTimeout.resolve();
  await eventually(async () => {
    const history = await f.request(`/v1/agents/${f.input.agent}/history`);
    return history.json.messages?.filter((entry: { role: string }) => entry.role === "assistant").length === 3;
  });
  assert.equal(frames.filter(frame => frame.item?.content?.[0]?.text?.includes("eventual reply")).length, 1);

  const done = { type: "response.done", response: { id: "response-1", status: "completed", usage: { output_token_details: { audio_tokens: 2000 } } } };
  send({ type: "response.created", response: { id: "response-1" } });
  send(done);
  send(done);
  const live = await eventually(async () => {
    const result = await f.request(path);
    return result.json.turns === 1 && result.json;
  });
  assert.equal(live.state, "live");
  const debit = (await f.db.query("select usd from voice_test_debits")).rows;
  assert.deepEqual(debit, [{ usd: 0.128 }]);
  assert.equal((await f.request("/v1/voice/sessions?state=live")).json.calls.length, 1);
  const ended = await f.request(path + "/end", "POST", {});
  assert.equal(ended.json.state, "ended");
  assert.deepEqual((await f.request(path, "DELETE")).json, ended.json);
  assert.equal(hangups.length, 1);

  const nextSocket = once(sockets, "connection");
  const next = await f.create({ provider: "openai", sdp: "next-offer" });
  assert.equal(next.status, 201, JSON.stringify(next.json));
  const [secondSideband] = await nextSocket;
  secondSideband.close();
  const dropped = await eventually(async () => {
    const result = await f.request(`/v1/voice/sessions/${next.json.id}`);
    return result.json.state === "ended" && result.json;
  });
  assert.equal(dropped.reason, "error");

  const expires = await f.create({ provider: "openai", sdp: "expire-offer" });
  assert.equal(expires.status, 201, JSON.stringify(expires.json));
  await f.request(`/__test/voice-alarm?id=${expires.json.id}&kind=expiry`, "POST");
  assert.equal((await f.request(`/v1/voice/sessions/${expires.json.id}`)).json.reason, "max_duration");

  const budgetSocket = once(sockets, "connection");
  const budget = await f.create({ provider: "openai", subject: "drain", sdp: "budget-offer" });
  assert.equal(budget.status, 201, JSON.stringify(budget.json));
  const [budgetSideband] = await budgetSocket;
  const budgetPath = `/v1/voice/sessions/${budget.json.id}`;
  const push = (event: object) => budgetSideband.send(JSON.stringify(event));
  push({ type: "response.created", response: { id: "response-1" } });
  push(done);
  await eventually(async () => (await f.request(budgetPath)).json.turns === 1);
  push({ type: "response.created", response: { id: "response-2" } });
  assert.equal((await f.request(budgetPath)).json.state, "live");
  push({ ...done, response: { ...done.response, id: "response-2" } });
  const budgetEnded = await eventually(async () => {
    const result = await f.request(budgetPath);
    return result.json.state === "ended" && result.json;
  });
  assert.equal(budgetEnded.reason, "budget");
  assert.equal(budgetEnded.turns, 2);
  assert.equal(budgetEnded.costUsd, 0.256);

  const before = Number((await f.db.query("select count(*) from voice_test_debits")).rows[0].count);
  await f.restart({ TEST_VOICE_CREDITS: "0" });
  const unmeteredSocket = once(sockets, "connection");
  const unmetered = await f.create({ provider: "openai", sdp: "tenant-paid-offer" });
  assert.equal(unmetered.status, 201, JSON.stringify(unmetered.json));
  const [tenantSideband] = await unmeteredSocket;
  const tenantPath = `/v1/voice/sessions/${unmetered.json.id}`;
  tenantSideband.send(JSON.stringify(done));
  await eventually(async () => (await f.request(tenantPath)).json.turns === 1);
  assert.equal(Number((await f.db.query("select count(*) from voice_test_debits")).rows[0].count), before);
  assert.equal((await f.request(tenantPath, "DELETE")).json.costUsd, 0.128);
});
