// Run after deploying wrangler.jsonc and setting PROBE_TOKEN through stdin.
// Contains no Cloudflare/AWS credentials; stdout is timing and instance evidence.
import { openEventStream } from "../../../../clients/event-transport.ts";

const origin = process.argv[2];
const transport = process.env.PROBE_TRANSPORT ?? 'websocket';
const suffix = `?agent=idle-${transport}`;
if (!origin || !process.env.PROBE_TOKEN) throw new Error("Pass Worker origin and set PROBE_TOKEN");
const headers = { Authorization: `Bearer ${process.env.PROBE_TOKEN}` };
const signal = new AbortController();
const get = async path => {
  const response = await fetch(new URL(path + suffix, origin), { headers });
  if (!response.ok) throw new Error(`Probe HTTP ${response.status}`);
  return response.json();
};
const initialized = await fetch(new URL("/initialize" + suffix, origin), { method: "POST", headers });
if (!initialized.ok) throw new Error(`Initialize HTTP ${initialized.status}`);
const startedAt = new Date().toISOString();
const meta = await get("/meta");
const initial = await get("/state");
const stream = await openEventStream(fetch, new URL(`/events${suffix}&snapshot=1&watch=1`, origin).href, { headers, signal: signal.signal }, transport === 'sse' ? 'sse' : 'websocket,sse');
if (transport === 'websocket' && stream.headers.get("x-agent-transport") !== "websocket") throw new Error("Probe did not negotiate WebSocket");
const reader = stream.body.getReader();
// Read the initial frames, then leave the connection completely idle.
await reader.read();
console.log(JSON.stringify({ phase: "idle-start", transport, startedAt, ...meta, initialInstance: initial.localInstanceId }));
const idleMs = Number(process.env.IDLE_MS ?? 180_000);
await new Promise(resolve => setTimeout(resolve, idleMs));
const idleEndedAt = new Date().toISOString();
const final = await get("/state");
console.log(JSON.stringify({ phase: "idle-end", transport, idleEndedAt, idleMs, finalInstance: final.localInstanceId,
  hibernated: initial.localInstanceId !== final.localInstanceId, connected: true,
  note: "Compare this objectId and idle window with Cloudflare duration metrics; instance replacement proves eviction only." }));
signal.abort();
await reader.cancel().catch(() => {});
