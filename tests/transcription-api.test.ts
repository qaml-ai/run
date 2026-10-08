import { test } from "node:test";
import assert from "node:assert/strict";
import { until } from "./runtime-server.ts";
import { CAPPED, HELLO, OPS, OWN, PAYG, start } from "./transcription-fixture.ts";

test("POST /v1/transcriptions takes audio as base64, multipart or a URL, runs on the platform's OpenAI key for a prepaid tenant, and is billed per second", async t => {
  const { r, openai } = await start(t);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  const endpoint = await r.call("/v1/webhooks", { body: { url: "https://hooks.example.test/usage", events: ["usage.recorded"] }, token: PAYG });
  assert.equal(endpoint.status, 201, endpoint.text);

  const json = await r.call("/v1/transcriptions", { body: { data: HELLO.toString("base64"), language: "en", subject: "user_1", context: { org: "o1" }, actor: "user_2" }, token: PAYG });
  assert.equal(json.status, 200, json.text);
  assert.deepEqual(json.json, { text: "Hello from camelRun.", language: "en", durationSeconds: 5, model: "openai/gpt-transcribe", costUsd: 0.05 });
  assert.deepEqual(openai.requests.at(-1), { key: "Bearer platform-openai-key", model: "gpt-transcribe", language: "en", name: "audio.ogg", bytes: HELLO.length });

  const form = new FormData();
  form.set("file", new Blob([HELLO], { type: "audio/ogg" }), "voice-message.ogg");
  form.set("prompt", "camelRun");
  const multipart = await fetch(`${r.base}/v1/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${PAYG}` }, body: form });
  assert.equal(multipart.status, 200);
  assert.equal((await multipart.json()).text, "Hello from camelRun.");
  assert.equal(openai.requests.at(-1)!.model, "gpt-transcribe");
  assert.equal((await r.call("/v1/transcriptions", { body: { data: HELLO.toString("base64"), timestamps: true }, token: PAYG })).status, 400, "no timestamps option");

  const byUrl = await r.call("/v1/transcriptions", { body: { url: `${openai.base}/hello.ogg` }, token: PAYG });
  assert.equal(byUrl.status, 200, byUrl.text);
  assert.equal(byUrl.json.text, "Hello from camelRun.");

  // Refused before anything is sent.
  const sent = openai.requests.length;
  const notAudio = await r.call("/v1/transcriptions", { body: { data: Buffer.from("plain text, not audio").toString("base64") }, token: PAYG });
  assert.equal(notAudio.status, 415);
  assert.equal(notAudio.json.code, "UNSUPPORTED_AUDIO");
  assert.equal((await r.call("/v1/transcriptions", { body: { data: "", url: "https://x.example/a.ogg" }, token: PAYG })).status, 400, "data or url, not both");
  assert.equal((await r.call("/v1/transcriptions", { body: { url: "http://10.0.0.1/a.ogg" }, token: PAYG })).status, 400, "the outbound guard refuses private addresses");
  assert.equal((await r.call("/v1/transcriptions", { body: { data: HELLO.toString("base64"), language: "not a language" }, token: PAYG })).status, 400);
  assert.equal(openai.requests.length, sent);

  // Three transcriptions of 5 seconds at a cent a second: $0.15 of credit, a usage row of their own, and an event each.
  await until(async () => (await r.call("/v1/billing", { token: PAYG })).json.balance === 850_000, "the transcriptions' charge");
  const usage = (await r.call("/v1/usage", { token: PAYG })).json.days;
  assert.deepEqual(usage.filter((day: any) => day.kind === "transcription").map((day: any) => [day.model, day.responses, Math.round(day.platformCost * 1e6)]), [["openai/gpt-transcribe", 3, 150_000]]);
  const ledger = (await r.call("/v1/billing/ledger", { token: PAYG })).json.entries.find((entry: any) => entry.kind === "usage");
  assert.deepEqual([ledger.metadata.transcription, ledger.metadata.transcriptions, ledger.metadata.audioSeconds], [150_000, 3, 15]);
  const { rows } = await r.db.query("select body from webhook_deliveries where tenant = 'payg' order by created_at");
  const events = rows.map(row => row.body.data).filter((data: any) => data.kind === "transcription");
  assert.equal(events.length, 3);
  assert.deepEqual(events.find((data: any) => data.subject === "user_1"), {
    agentId: null, requestId: null, subject: "user_1", actor: "user_2", context: { org: "o1" }, keyScope: null, provider: "openai", model: "gpt-transcribe", kind: "transcription",
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, audioSeconds: 5, cost: { usd: 0.05, source: "catalog" }, at: events.find((data: any) => data.subject === "user_1").at,
  });
  // Nothing of the audio or its transcript is logged.
  assert.ok(r.logs.some(line => line.includes('"type":"transcribed"')));
  assert.ok(!r.logs.some(line => line.includes("Hello from camelRun")), "no transcript in the logs");
});

test("audio attached to a message is transcribed before the request is accepted: the model reads the transcript, history keeps it with the audio, and it is billed to the run's agent and budget", async t => {
  const { r, openai } = await start(t);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  const agent = (await r.call("/v1/agents", { body: { spendLimit: { usd: 1 } }, token: PAYG })).json.id;
  const voice = { name: "voice-message.ogg", data: HELLO.toString("base64"), contentType: "audio/ogg" };

  // A voice message alone: its transcript is the message.
  const record = await r.prompt(agent, undefined as unknown as string, PAYG, { files: [voice] });
  assert.match(record.outcome.result.reply, /heard: \[Audio \/workspace\/uploads\/[^ ]+\/voice-message\.ogg \(audio\/ogg, 0:05, en\), transcript:\nHello from camelRun\.\n\]/);
  assert.equal(openai.requests.length, 1);
  const history = (await r.call(`/v1/agents/${agent}/history`, { token: PAYG })).json;
  const user = history.messages.find((message: any) => message.role === "user");
  const file = user.content.find((block: any) => block.type === "file");
  assert.deepEqual(file.transcript, { text: "Hello from camelRun.", language: "en", seconds: 5, model: "gpt-transcribe" });
  assert.equal(file.contentType, "audio/ogg");
  assert.ok(!user.content.some((block: any) => block.type === "text"), "no empty text beside it");
  // Its cost counts against the agent's spend limit, as a model response's does.
  await until(async () => (await r.call(`/v1/agents/${agent}`, { token: PAYG })).json.spendLimit?.spent >= 0.05, "the agent's spend");

  // With text, and a file that is not audio: only the audio is transcribed.
  const both = await r.prompt(agent, "what did I say?", PAYG, { files: [voice, { name: "notes.txt", data: Buffer.from("notes").toString("base64") }] });
  assert.match(both.outcome.result.reply, /heard: what did I say\?.*transcript:\nHello from camelRun\..*\[File \/workspace\/uploads\/[^ ]+\/notes\.txt/s);
  assert.equal(openai.requests.length, 2);
  // transcribe: false keeps audio a plain file.
  const kept = await r.prompt(agent, "keep it", PAYG, { files: [{ ...voice, transcribe: false }] });
  assert.match(kept.outcome.result.reply, /\[File \/workspace\/uploads\/[^ ]+\/voice-message\.ogg \(audio\/ogg, 13 KB\)\]/);
  assert.equal(openai.requests.length, 2);

  // A run's own budget pays for its audio first: one too small for it is refused before anything is sent.
  const poor = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "hi", files: [voice], spendLimit: { usd: 0.01 } }, token: PAYG });
  assert.equal(poor.status, 402);
  assert.equal(poor.json.code, "SPEND_LIMIT");
  assert.equal(openai.requests.length, 2);
  // A retry with the same id transcribes once.
  const body = { text: "again", files: [voice], requestId: "voice-retry" };
  const [first, second] = await Promise.all([r.call(`/v1/agents/${agent}/prompt`, { body, token: PAYG }), r.call(`/v1/agents/${agent}/prompt`, { body, token: PAYG })]);
  assert.deepEqual([first.status, second.status, first.json.id], [202, 202, second.json.id]);
  assert.equal(openai.requests.length, 3);

  // Three transcriptions at $0.05.
  await until(async () => Math.abs((await r.call("/v1/usage", { token: PAYG })).json.days.find((day: any) => day.kind === "transcription")?.platformCost - 0.15) < 1e-9, "the usage row");
  // A stateless run takes audio as an input part, by URL too.
  const run = await r.call("/v1/runs?wait=30", { body: { input: [{ type: "file", url: `${openai.base}/hello.ogg` }] }, token: PAYG });
  assert.equal(run.status, 200, run.text);
  assert.equal(run.json.status, "completed");
  assert.match(run.json.text, /^heard: \[Audio .*hello\.ogg \(audio\/ogg, 0:05, en\), transcript:\nHello from camelRun\.\n\]$/);
});

test("audio a message sends by default reaches the agent untranscribed, with why, when the tenant has no OpenAI key; one it asks to transcribe is refused; a monthly cap refuses transcriptions", async t => {
  const { r, openai } = await start(t);
  const agent = (await r.call("/v1/agents", { body: {}, token: OWN })).json.id;
  const voice = { name: "voice.ogg", data: HELLO.toString("base64") };
  const record = await r.prompt(agent, "(sent a voice message)", OWN, { files: [voice] });
  assert.match(record.outcome.result.reply, /voice\.ogg \(audio\/ogg, 13 KB\): not transcribed \(Transcription needs an OpenAI key/);
  const asked = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "hi", files: [{ ...voice, transcribe: true }] }, token: OWN });
  assert.equal(asked.status, 400);
  assert.equal(asked.json.code, "TRANSCRIPTION_UNAVAILABLE");
  const alone = await r.call("/v1/transcriptions", { body: { data: HELLO.toString("base64") }, token: OWN });
  assert.equal(alone.status, 400);
  assert.match(alone.json.error, /PUT \/v1\/providers\/openai\/key/);
  const capped = await r.call("/v1/transcriptions", { body: { data: HELLO.toString("base64") }, token: CAPPED });
  assert.equal(capped.status, 402);
  assert.equal(openai.requests.length, 0);
});
