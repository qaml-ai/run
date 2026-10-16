import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { deferredLive, openaiLiveTranscription } from "../src/transcription-live.ts";
import { fakeRealtime } from "./voice-fakes.ts";

async function listening(t: { after(fn: () => unknown): void }) {
  const server = createServer((_req, res) => { res.writeHead(404).end(); }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
}

test("live transcription: audio streams as it comes, each commit answers its own audio's transcript, in order", async t => {
  const { server, url } = await listening(t);
  let n = 0;
  const seen = fakeRealtime(server, () => `utterance ${++n}`, 20);
  const provider = openaiLiveTranscription({ baseUrl: url, delay: "low" });
  const stream = provider.connect({ apiKey: "sk-test" }, { language: "en", prompt: "names: Miguel" })!;
  // Appended before the socket opens: kept, and sent in order once it does.
  stream.append(Buffer.alloc(48_000));
  const first = stream.commit();
  stream.append(Buffer.alloc(24_000));
  stream.clear();
  stream.append(Buffer.alloc(96_000));
  const second = stream.commit();
  assert.deepEqual(await first, { text: "utterance 1", seconds: 1, model: "gpt-live-transcribe" });
  assert.deepEqual(await second, { text: "utterance 2", seconds: 2, model: "gpt-live-transcribe" });
  assert.deepEqual(seen.commits, [48_000, 96_000]);
  assert.equal(seen.clears, 1);
  assert.deepEqual(seen.sessions[0].audio.input.transcription, { model: "gpt-live-transcribe", language: "en", prompt: "names: Miguel", delay: "low" });
  stream.close();
  assert.equal(stream.closed, true);
  await assert.rejects(stream.commit(), /closed/);
});

test("live transcription: completions out of order go to their own commits; a dropped connection fails what waits", async t => {
  const { server, url } = await listening(t);
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => sockets.handleUpgrade(req, socket, head, ws => {
    let item = 0;
    ws.on("message", data => {
      const event = JSON.parse(String(data));
      if (event.type !== "input_audio_buffer.commit") return;
      const id = `item_${++item}`;
      ws.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: id }));
      // The second answers first; the third never does, and the connection drops.
      if (item === 2) {
        ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_2", transcript: "two" }));
        ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: " one " }));
      }
      if (item === 3) setTimeout(() => ws.terminate(), 20);
    });
  }));
  const stream = openaiLiveTranscription({ baseUrl: url }).connect({ apiKey: "sk-test" }, {})!;
  stream.append(Buffer.alloc(9_600));
  const one = stream.commit();
  stream.append(Buffer.alloc(9_600));
  const two = stream.commit();
  stream.append(Buffer.alloc(9_600));
  const three = stream.commit();
  assert.equal((await one).text, "one");
  assert.equal((await two).text, "two");
  await assert.rejects(three, /closed/);
  assert.equal(stream.closed, true);
});

test("live transcription: credentials that cannot stream, and a stream still finding its key", async () => {
  const provider = openaiLiveTranscription({ baseUrl: "http://127.0.0.1:9/v1" });
  assert.equal(provider.connect({ apiKey: "k", baseUrl: "https://gateway.example" }, {}), undefined, "a key scope's own address");
  assert.equal(provider.connect({ apiKey: "k", via: "azure" }, {}), undefined, "Azure without an OpenAI fallback");
  const none = deferredLive(Promise.resolve(undefined));
  none.append(Buffer.alloc(960));
  await assert.rejects(none.commit(), /No key/);
  assert.equal(none.closed, true);
});
