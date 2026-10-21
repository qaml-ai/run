/**
 * One Pi step commit's latency under a claim (as on a distributed node): statements and p50 ms of an entry + task
 * commit, with RTT_MS added to every statement.
 *
 *   AGENT_TEST_DATABASE_URL=postgres://... RTT_MS=1 node --experimental-strip-types benchmarks/session-memory/commit-latency.ts
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { PostgresPiStorage } from "../../src/pi-durable/storage.ts";
import { Ownership } from "../../src/ownership.ts";
import { migrate } from "../../src/db.ts";
const rtt = Number(process.env.RTT_MS ?? 0);
const pool = new pg.Pool({ connectionString: process.env.AGENT_TEST_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:55432/postgres", max: 4 });
await migrate(pool);
let n = 0;
const delay = () => rtt ? new Promise(r => setTimeout(r, rtt)) : undefined;
const db = new Proxy(pool, { get(t, k) {
  if (k === "query") return async (...a: any[]) => { await delay(); n++; return (t.query as any)(...a); };
  if (k === "connect") return async () => { const c = await t.connect(); return new Proxy(c, { get(i, m) {
    if (m === "query") return async (...a: any[]) => { await delay(); n++; return (i.query as any)(...a); };
    const v = Reflect.get(i, m, i); return typeof v === "function" ? v.bind(i) : v; } }); };
  const v = Reflect.get(t, k, t); return typeof v === "function" ? v.bind(t) : v; } }) as any;
const own = new Ownership(pool as any, { node: `b-${randomUUID()}` }); await own.start();
const got: any = await own.acquire(`a-${randomUUID()}`);
const s = await PostgresPiStorage.open(db, randomUUID(), got.claim);
await s.commit([{ type: "conversation", value: { id: 1 } }], context);
const times: number[] = []; let stmts = 0;
for (let i = 0; i < 40; i++) {
  const [e, task] = await s.mintIds(2);
  n = 0; const t0 = performance.now();
  await s.commit([{ type: "entry", value: { id: e, conversationId: 1, kind: "m" } }, { type: "task", value: { id: task, conversationId: 1, kind: "k", state: { status: "running" } } }] as any, context);
  times.push(performance.now() - t0); stmts = n;
}
times.sort((a, b) => a - b);
console.log(`RTT ${rtt}: ${stmts} statements per commit, p50 ${times[20].toFixed(1)} ms`);
await s.close(context); await own.close(); await pool.end();
