/** CTO-reviewed backend differences (2026-11-05); exact case identities only.
 * Node must still run these assertions. Workers records a separate non-pass status.
 */
export const reasons = Object.freeze({
  websocket: "Workers is WebSocket-only for live streams by CTO decision (2026-11-05); SSE keeps Durable Objects billed while idle",
  sandbox: "Workers code mode uses Pi’s QuickJS remote sandbox by CTO decision; Node uses V8.",
  recovery: "Durable Objects recover their own durable state; ECS-only Postgres pending_runs, versioned headers and resume_failures/resume_after are not the Workers recovery contract.",
  drain: "ECS load balancer keep-alive and drain (timeout=365) are not the Workers transport lifecycle.",
});

export const acceptedDifferences = Object.freeze([
  {"area": "access", "source": "tests/tenant-reads.test.ts:117", "name": "an agent with work left that cannot be loaded is tried again with capped backoff, never for good, and says so", reason: reasons.recovery },
  {"area": "access", "source": "tests/tenant-reads.test.ts:144", "name": "a request whose open-work mark could not be written is not taken, and its retry runs", reason: reasons.recovery },
  {"area": "history", "source": "tests/pi-durable-context-guard.test.ts:107", "name": "an oversized resumed range fails once, clears pending work, and remains readable and abortable", reason: reasons.recovery },
  {"area": "tools", "source": "tests/code-engine.test.ts:21", "name": "codemode runs on V8 for every tenant, and the limits API refuses an engine", reason: reasons.sandbox },
  {"area": "transport", "source": "tests/http-drain.test.ts:15", "name": "idle sockets outlive the load balancer's 360 s; a drain answers a long poll under way in full, with Connection: close", reason: reasons.drain },
  {"area":"tools","source":"tests/attach.test.ts:6","name":"one application serves an agent's tools at a time: another connection is refused unless it takes over, and the replaced one is told why", reason: reasons.websocket },
  {"area":"tools","source":"tests/attach.test.ts:31","name":"the application's own connection still answers a replay gap with 409 unless it asks for a snapshot, as relays that do not read snapshots expect", reason: reasons.websocket },
  {"area":"transport","source":"tests/cors.test.ts","name":"any origin may read an agent with a browser token, on the four read routes only; the tenant's own tokens never get CORS", reason: reasons.websocket },
  {"area":"sdk","source":"tests/sdk-lazy-connections.test.ts","name":"a lazy handle's stream() connects for the run, yields it from its start, and lets the stream go after", reason: reasons.websocket },
  {"area":"sdk","source":"tests/sdk-lazy-connections.test.ts","name":"handles that need the stream keep it: onEvent, served tools, or connection: eager", reason: reasons.websocket },
  {"area":"transport","source":"tests/ui-proxy.test.ts","name":"proxy: a fetch-style route (Next.js route handlers, Workers) streams the user's own agent's events as they come", reason: reasons.websocket },
  {"area":"transport","source":"tests/ui-proxy.test.ts","name":"proxy: a browser that goes away aborts the upstream stream", reason: reasons.websocket },
  {"area":"transport","source":"tests/ui-proxy.test.ts","name":"proxy: Hono streams it", reason: reasons.websocket },
  {"area":"transport","source":"tests/ui-proxy.test.ts","name":"proxy: Express (nodeListener) streams it", reason: reasons.websocket },
  {"area":"transport","source":"tests/ui-proxy.test.ts","name":"proxy: the chat store reads only through the route, per thread", reason: reasons.websocket },
  {"area":"transport","source":"tests/watch.test.ts","name":"a watcher (sse) folds the stream into Pi messages as they grow, tool arguments included, and renews its token", reason: reasons.websocket },
  {"area":"transport","source":"tests/watch.test.ts","name":"a watcher whose streams deliver nothing (a proxy that buffers them) falls back to long polls", reason: reasons.websocket },
 ].map(row => Object.freeze({ ...row, reviewedBy: "CTO", reviewedAt: "2026-11-05" })));

const key = row => `${row.area}\0${row.source}\0${row.name}`;
const byCase = new Map(acceptedDifferences.map(row => [key(row), row]));

export function acceptedDifference(row, backend) {
  return backend === "workers" ? byCase.get(key(row)) : undefined;
}

export function differenceResult(row) {
  const decision = acceptedDifference(row, "workers");
  if (!decision) throw new Error(`No reviewed difference for ${row.name}`);
  return { ...row, status: "accepted-difference", backend: "workers", reason: decision.reason,
    reviewedBy: decision.reviewedBy, reviewedAt: decision.reviewedAt };
}

export function validateDifferences(rows, backend) {
  for (const row of rows) {
    const decision = acceptedDifference(row, backend);
    if (decision && row.status !== "accepted-difference")
      throw new Error(`Reviewed difference cannot count as ${row.status}: ${row.name}`);
    if (row.status !== "accepted-difference") continue;
    if (!decision || row.backend !== "workers" || row.reason !== decision.reason ||
        row.reviewedBy !== decision.reviewedBy || row.reviewedAt !== decision.reviewedAt)
      throw new Error(`Unreviewed accepted difference: ${row.name}`);
  }
}

export function validateDifferenceInventory(rows) {
  for (const decision of acceptedDifferences) {
    if (rows.filter(row => key(row) === key(decision)).length !== 1)
      throw new Error(`Reviewed difference missing or duplicated in inventory: ${decision.name}`);
  }
}
