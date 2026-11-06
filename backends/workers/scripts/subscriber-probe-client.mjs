import tls from "node:tls";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const base = new URL(process.argv[2]);
const session = randomUUID();
const closeMode = process.argv[4] ?? "full-close";
const start = Date.now();
const events = [];
const record = (event, extra = {}) => events.push({ event, at: Date.now(), elapsedMs: Date.now() - start, ...extra });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const address = (path, params = {}) => {
  const url = new URL(path, base);
  url.search = new URLSearchParams({ session, ...params });
  return url;
};
const probe = async id => {
  const response = await fetch(address("/subscribe", { id, watch: "1", poll: "1" }));
  await response.text();
  record(id, { status: response.status });
  return response.status;
};
await probe("warm");
const socket = tls.connect({ host: base.hostname, port: 443, servername: base.hostname, ALPNProtocols: ["http/1.1"], allowHalfOpen: true });
socket.on("error", error => record("socket-error", { error: String(error) }));
socket.on("data", chunk => record("socket-data", { bytes: chunk.length, firstLine: chunk.toString().split("\r\n")[0] }));
socket.on("end", () => record("socket-end"));
socket.on("close", () => record("socket-close"));
socket.on("finish", () => record("socket-finish"));
await new Promise((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", reject); });
const url = address("/subscribe", { id: "cancelled", watch: "1", delay: "1000" });
socket.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${base.hostname}\r\nConnection: close\r\n\r\n`);
record("subscribe-sent");
// Confirm the request reached eventRead before closing its TCP write side.
let trace = [];
for (let i = 0; i < 15; i++) {
  trace = await fetch(address("/trace")).then(r => r.json());
  if (trace.some(e => e.id === "cancelled" && e.event === "forward-start")) break;
  await pause(20);
}
const occupied = await probe("while-open");
record("socket-fin-sent");
socket.end(); // Request a normal TLS close_notify + TCP FIN.
if (closeMode === "full-close") {
  if (!socket.writableFinished) await new Promise(resolve => socket.once("finish", resolve));
  record("socket-destroy-after-finish");
  socket.destroy(); // Ordinary close after FIN, not resetAndDestroy().
}
let freedAfterMs;
const finAt = Date.now();
for (let i = 0; i < 25; i++) {
  await pause(100);
  if (await probe(`after-fin-${i}`) === 200) { freedAfterMs = Date.now() - finAt; break; }
}
trace = await fetch(address("/trace")).then(r => r.json());
const result = { startedAt: new Date(start).toISOString(), url: base.origin, session, occupied, freedAfterMs: freedAfterMs ?? null, closeMode, normalFin: true, events, trace };
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ...result, events: undefined, trace: undefined }, null, 2));
// The diagnostic is bounded even when the deployed stream failed to cancel.
socket.unref();
process.exitCode = occupied === 429 && freedAfterMs !== undefined ? 0 : 1;
