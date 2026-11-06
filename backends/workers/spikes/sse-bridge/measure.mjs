// Opens four idle streams, waits, sends one event to each object, logs JSON lines.
import { readFileSync } from "node:fs";
const dir = new URL(".", import.meta.url).pathname;
const token = readFileSync(dir + "token.txt", "utf8").trim();
const origin = process.argv[2];
const idleMs = Number(process.env.IDLE_MS ?? 720_000);
const S = process.env.S ?? "";
const H = { authorization: `Bearer ${token}` };
const log = o => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
const api = async (path, obj, init = {}) => (await fetch(`${origin}${path}?obj=${obj}`, { headers: H, ...init })).json();

const results = {};
async function sse(label, path, obj) {
  const meta = await api("/meta", obj);
  results[label] = { ...meta, chunks: [], heartbeats: 0 };
  const res = await fetch(`${origin}${path}`, { headers: H });
  log({ label, phase: "open", status: res.status, ...meta });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { log({ label, phase: "eof" }); results[label].eof = new Date().toISOString(); break; }
        const text = dec.decode(value);
        if (text.startsWith(": hb")) { results[label].heartbeats++; results[label].lastHeartbeat = new Date().toISOString(); continue; }
        results[label].chunks.push({ t: new Date().toISOString(), text });
        log({ label, phase: "data", text });
      }
    } catch (e) { log({ label, phase: "error", error: String(e) }); results[label].error = String(e); }
  })();
  return reader;
}
function ws(label, obj) {
  return api("/meta", obj).then(meta => new Promise(resolve => {
    results[label] = { ...meta, chunks: [], pings: 0 };
    const socket = new WebSocket(`${origin.replace("https", "wss")}/ws?obj=${obj}&token=${token}`);
    socket.onopen = () => { log({ label, phase: "open", ...meta }); resolve(socket); };
    socket.onmessage = e => {
      if (e.data === "pong") { results[label].pings++; return; }
      results[label].chunks.push({ t: new Date().toISOString(), text: e.data }); log({ label, phase: "data", text: e.data });
    };
    socket.onclose = e => { log({ label, phase: "close", code: e.code }); results[label].closed = { code: e.code, t: new Date().toISOString() }; };
    socket.onerror = e => log({ label, phase: "ws-error", error: String(e.message ?? e) });
    const timer = setInterval(() => { try { socket.send("ping"); } catch { clearInterval(timer); } }, 30_000);
    socket.pingTimer = timer;
  }));
}

const startedAt = new Date().toISOString();
const socket = await ws("websocket-direct", "ws-direct"+S);
const r1 = await sse("sse-direct", `/sse?obj=sse-direct${S}`, "sse-direct"+S);
const r2 = await sse("sse-bridge", `/bridge?obj=bridge-a${S}`, "bridge-a"+S);
const r3 = await sse("sse-bridge-wsping", `/bridge?obj=bridge-b${S}&wsping=1`, "bridge-b"+S);
log({ phase: "idle-start", idleMs });
await new Promise(r => setTimeout(r, idleMs));
const idleEndedAt = new Date().toISOString();
const sends = {};
for (const [label, obj] of [["websocket-direct", "ws-direct"+S], ["sse-direct", "sse-direct"+S], ["sse-bridge", "bridge-a"+S], ["sse-bridge-wsping", "bridge-b"+S]]) {
  sends[label] = await api("/send", obj, { method: "POST" });
  log({ label, phase: "sent", ...sends[label] });
}
await new Promise(r => setTimeout(r, 10_000));
const endedAt = new Date().toISOString();
clearInterval(socket.pingTimer); socket.close(1000, "done");
for (const r of [r1, r2, r3]) await r.cancel().catch(() => {});
await new Promise(r => setTimeout(r, 3_000));
console.log("RESULT " + JSON.stringify({ startedAt, idleEndedAt, endedAt, idleMs, sends, results }));
process.exit(0);
