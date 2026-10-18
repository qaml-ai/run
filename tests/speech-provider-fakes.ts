import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * Fake streaming speech providers (Deepgram Nova and Flux, Soniox, AssemblyAI), each speaking its provider's wire
 * protocol over a WebSocket on a local server, so adapters are tested without keys or calls. Audio is 24 kHz mono
 * 16-bit PCM: a sample that is not 0 is speech, so a test says where speech and silence are by what it sends.
 */

export const MS = 48;
/** `ms` of speech (non-zero samples) or of silence. */
export const speech = (ms: number) => Buffer.alloc(ms * MS, 1);
export const silence = (ms: number) => Buffer.alloc(ms * MS);

export async function listening(t: { after(fn: () => unknown): void }, handler?: (req: IncomingMessage, res: import("node:http").ServerResponse) => void) {
  const server = createServer(handler ?? ((_req, res) => { res.writeHead(404).end(); })).listen(0, "127.0.0.1");
  await once(server, "listening");
  const sockets = new WebSocketServer({ noServer: true });
  t.after(() => new Promise<void>(resolve => { for (const ws of sockets.clients) ws.terminate(); server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { server, sockets, base };
}

export type Seen = { urls: string[]; auth: string[]; text: any[]; audioMs: number[]; connections: number };

function upgrade(server: Server, sockets: WebSocketServer, seen: Seen, onConnection: (ws: WebSocket, index: number) => void) {
  server.on("upgrade", (req, socket, head) => {
    seen.urls.push(req.url ?? "");
    seen.auth.push(String(req.headers.authorization ?? ""));
    sockets.handleUpgrade(req, socket, head, ws => {
      const index = seen.connections++;
      seen.audioMs[index] = 0;
      onConnection(ws, index);
    });
  });
}

const seenNew = (): Seen => ({ urls: [], auth: [], text: [], audioMs: [], connections: 0 });

/** Words for a stretch of audio: `say(n)` names the nth stretch's words (n from 1), laid out evenly across its speech. */
function timedWords(text: string, fromMs: number, toMs: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const span = Math.max(1, (toMs - fromMs) / Math.max(1, words.length));
  return words.map((word, index) => ({ word, startMs: fromMs + index * span, endMs: fromMs + (index + 1) * span }));
}

/** Deepgram's /v1/listen: interim results as audio comes, final words on Finalize (`from_finalize`). */
export function fakeDeepgram(server: Server, sockets: WebSocketServer, say: (n: number) => string, options: { finalizeDelayMs?: number; dropOnConnection?: number } = {}) {
  const seen = seenNew();
  upgrade(server, sockets, seen, (ws, index) => {
    if (options.dropOnConnection === index) { setTimeout(() => ws.terminate(), 5); return; }
    let receivedMs = 0, finalizedMs = 0, n = 0;
    ws.on("message", (data, binary) => {
      if (binary) {
        receivedMs += (data as Buffer).length / MS;
        seen.audioMs[index] = receivedMs;
        ws.send(JSON.stringify({ type: "Results", is_final: false, start: finalizedMs / 1000, duration: (receivedMs - finalizedMs) / 1000, channel: { alternatives: [{ transcript: "partial words", words: [] }] } }));
        return;
      }
      const event = JSON.parse(String(data));
      seen.text.push(event);
      if (event.type !== "Finalize") return;
      const from = finalizedMs, to = receivedMs;
      finalizedMs = receivedMs;
      const words = timedWords(say(++n), from, to);
      setTimeout(() => ws.send(JSON.stringify({
        type: "Results", is_final: true, speech_final: false, from_finalize: true, start: from / 1000, duration: (to - from) / 1000,
        channel: { alternatives: [{ transcript: words.map(word => word.word).join(" "), words: words.map(word => ({ word: word.word.toLowerCase(), punctuated_word: word.word, start: word.startMs / 1000, end: word.endMs / 1000 })) }] },
      })), options.finalizeDelayMs ?? 5);
    });
  });
  return seen;
}

/**
 * Deepgram Flux's /v2/listen: a turn starts with speech; after 200 ms of silence it is eagerly over, after 400 ms over
 * (EndOfTurn with `say(n)`); speech within those resumes it.
 */
export function fakeFlux(server: Server, sockets: WebSocketServer, say: (n: number) => string) {
  const seen = seenNew();
  upgrade(server, sockets, seen, (ws, index) => {
    let receivedMs = 0, quietMs = 0, turn = -1, open = false, eager = false, startMs = 0;
    ws.send(JSON.stringify({ type: "Connected", request_id: "fake" }));
    const info = (event: string, transcript: string, extra: Record<string, unknown> = {}) =>
      ws.send(JSON.stringify({ type: "TurnInfo", event, turn_index: turn, audio_window_start: startMs / 1000, audio_window_end: receivedMs / 1000, transcript, words: [], end_of_turn_confidence: event === "Update" ? 0.1 : 0.85, ...extra }));
    ws.on("message", (data, binary) => {
      if (!binary) { seen.text.push(JSON.parse(String(data))); return; }
      const bytes = data as Buffer;
      // 20 ms at a time, as a stream would hear it.
      for (let at = 0; at < bytes.length; at += 20 * MS) {
        const frame = bytes.subarray(at, at + 20 * MS);
        receivedMs += frame.length / MS;
        const loud = frame.some(sample => sample !== 0);
        if (loud) {
          quietMs = 0;
          if (!open) { open = true; eager = false; turn++; startMs = receivedMs - frame.length / MS; info("StartOfTurn", ""); }
          else if (eager) { eager = false; info("TurnResumed", "words so far"); }
          else if (Math.round(receivedMs) % 100 === 0) info("Update", "words so far");
        } else if (open) {
          quietMs += frame.length / MS;
          if (quietMs >= 200 && !eager) { eager = true; info("EagerEndOfTurn", say(turn + 1)); }
          if (quietMs >= 400) { open = false; info("EndOfTurn", say(turn + 1)); }
        }
      }
      seen.audioMs[index] = receivedMs;
    });
  });
  return seen;
}

/** Soniox's real-time API: config first, tokens as audio comes, final tokens and `<fin>` on finalize. */
export function fakeSoniox(server: Server, sockets: WebSocketServer, say: (n: number) => string) {
  const seen = seenNew();
  upgrade(server, sockets, seen, (ws, index) => {
    let receivedMs = 0, finalizedMs = 0, n = 0, configured = false;
    ws.on("message", (data, binary) => {
      if (!binary) {
        const text = String(data);
        if (!text) { ws.send(JSON.stringify({ tokens: [], finished: true })); ws.close(); return; }
        const event = JSON.parse(text);
        seen.text.push(event);
        if (!configured) {
          configured = true;
          if (event.api_key !== "soniox-key") { ws.send(JSON.stringify({ error_code: 401, error_message: "Invalid API key" })); ws.close(); }
          return;
        }
        if (event.type !== "finalize") return;
        const from = finalizedMs, to = receivedMs;
        finalizedMs = receivedMs;
        const tokens = timedWords(say(++n), from, to).map((word, i) => ({ text: `${i ? " " : ""}${word.word}`, start_ms: word.startMs, end_ms: word.endMs, is_final: true, language: "en" }));
        ws.send(JSON.stringify({ tokens: [...tokens, { text: "<fin>", is_final: true }], final_audio_proc_ms: to, total_audio_proc_ms: to }));
        return;
      }
      receivedMs += (data as Buffer).length / MS;
      seen.audioMs[index] = receivedMs;
      ws.send(JSON.stringify({ tokens: [{ text: "hear", start_ms: receivedMs - 10, end_ms: receivedMs, is_final: false }], final_audio_proc_ms: finalizedMs, total_audio_proc_ms: receivedMs }));
    });
  });
  return seen;
}

/** AssemblyAI's v3 streaming: Begin, partial turns as audio comes, an ended turn (then its formatted one) on ForceEndpoint. */
export function fakeAssemblyAI(server: Server, sockets: WebSocketServer, say: (n: number) => string) {
  const seen = seenNew();
  upgrade(server, sockets, seen, (ws, index) => {
    let receivedMs = 0, turnFromMs = 0, n = 0, order = 0, open = false;
    ws.send(JSON.stringify({ type: "Begin", id: "fake", expires_at: 0 }));
    ws.on("message", (data, binary) => {
      if (binary) {
        receivedMs += (data as Buffer).length / MS;
        seen.audioMs[index] = receivedMs;
        open = true;
        ws.send(JSON.stringify({ type: "Turn", turn_order: order, end_of_turn: false, turn_is_formatted: false, transcript: "", words: [{ text: "hear", start: receivedMs - 10, end: receivedMs, word_is_final: false }] }));
        return;
      }
      const event = JSON.parse(String(data));
      seen.text.push(event);
      if (event.type === "Terminate") { ws.send(JSON.stringify({ type: "Termination", audio_duration_seconds: receivedMs / 1000 })); ws.close(); return; }
      if (event.type !== "ForceEndpoint" || !open) return;
      open = false;
      const words = timedWords(say(++n), turnFromMs, receivedMs);
      turnFromMs = receivedMs;
      const turn = { type: "Turn", turn_order: order++, end_of_turn: true, end_of_turn_confidence: 0.9, words: words.map(word => ({ text: word.word, start: word.startMs, end: word.endMs, word_is_final: true })) };
      ws.send(JSON.stringify({ ...turn, turn_is_formatted: false, transcript: words.map(word => word.word.toLowerCase()).join(" ") }));
      setTimeout(() => ws.send(JSON.stringify({ ...turn, turn_is_formatted: true, transcript: words.map(word => word.word).join(" ") })), 5);
    });
  });
  return seen;
}
