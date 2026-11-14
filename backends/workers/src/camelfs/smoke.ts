import { randomUUID } from "node:crypto";
import { tierConfigured, TierError, tierRequest, type TierEnv } from "./tier.ts";
import { StorageError } from "../repos/storage.ts";
import { repoStorage } from "./repo-storage.ts";

const SMOKE_SUB = "runtime:camelfs-smoke";
const ROUTES = ["putBlob", "commit", "readBatch", "getCommit"] as const;
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/** One round on a throwaway lineage: PUT blob, POST commit (1 file), batch read, GET commit. `wall` collects each
 * fetch's duration by route (ledger L89 measures Worker -> tier wall time against the tier's server-side ms). */
async function smokeRound(env: TierEnv, lineage: string, round: number, wall: Record<string, number[]>, statuses: Record<string, Record<string, number>>) {
  const path = "probe.txt", sub = SMOKE_SUB;
  const bytes = new TextEncoder().encode(`${lineage}:${round}`);
  const storage = repoStorage(env, sub);
  async function measure<T>(op: (typeof ROUTES)[number], run: () => Promise<T>) {
    const start = performance.now(), count = (status: string) => { statuses[op][status] = (statuses[op][status] ?? 0) + 1; };
    try { const value = await run(); count("ok"); return value; }
    catch (e) {
      count(e instanceof StorageError ? String(e.status || 0) : "error");
      if (e instanceof StorageError) throw new TierError(e.status || 502, e.code, e.reason, e.details, op, e);
      throw e;
    } finally { wall[op].push(performance.now() - start); }
  }
  const blob = await measure("putBlob", () => storage.putBlob(lineage, bytes));
  const commit = await measure("commit", () => storage.commit(lineage, {
    parents: [], changes: [{ path, blob: blob.blob }], author: sub, message: "camelFS smoke",
    trailers: { "Camel-Op": "api" },
  }));
  const [entry] = await measure("readBatch", () => storage.readBatch(lineage, commit.tree, [path]));
  if (!entry || !("bytes" in entry) || !Buffer.from(bytes).equals(entry.bytes))
    throw new TierError(502, "read_mismatch", "camelFS smoke read did not match", undefined, "readBatch");
  const metadata = await measure("getCommit", () => storage.getCommit(lineage, commit.commit));
  if (metadata.tree !== commit.tree)
    throw new TierError(502, "commit_mismatch", "camelFS smoke commit did not match", undefined, "getCommit");
  return commit.commit;
}

/** `iterations` rounds (1..500) on one fresh lineage; the reply has per-route count and p50/p95/p99 ms, never ids
 * beyond the throwaway lineage itself. */
/** The throwaway lineage is registered like a real repo's (HttpRepoClient.prepareLineage): the tier refuses blob
 * uploads to an unregistered lineage (404 not_found). */
const lineageCall = (env: TierEnv, lineage: string, method: "PUT" | "DELETE", body?: unknown) => tierRequest(env, {
  method, path: "/v1/lineages/" + encodeURIComponent(lineage), body,
  claims: { sub: SMOKE_SUB, lin: lineage, acc: "w" }, idempotencyKey: method === "DELETE" ? `delete:${lineage}` : undefined,
});

export async function camelfsSmoke(env: TierEnv, iterations = 1, minSeconds = 0, tenant = "camelfs-smoke") {
  const lineage = "smoke:" + randomUUID(), wall = Object.fromEntries(ROUTES.map(r => [r, [] as number[]])) as Record<string, number[]>;
  const statuses = Object.fromEntries(ROUTES.map(r => [r, {} as Record<string, number>]));
  const startedAt = new Date().toISOString(), began = Date.now();
  let completed = 0, failure: TierError | undefined;
  await lineageCall(env, lineage, "PUT", { tenant, kind: "workspace", defaultBranch: "main" });
  // At least `iterations` rounds, continuing until `minSeconds` have passed (a clean edge for the server-side query).
  for (let round = 0; round < iterations || Date.now() - began < minSeconds * 1000; round++) {
    try { await smokeRound(env, lineage, round, wall, statuses); completed++; }
    catch (e) { if (!(e instanceof TierError)) throw e; failure = e; break; }
  }
  const routes = Object.fromEntries(ROUTES.map(route => {
    const sorted = [...wall[route]].sort((a, b) => a - b);
    return [route, { count: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99) }];
  }));
  const window = { startedAt, endedAt: new Date().toISOString() };
  // The lineage is deleted after the window; a failed delete is reported, not hidden (the reply stays 502).
  let cleanup: { deleted: true } | { deleted: false; status: number; code: string } = { deleted: true };
  try { await lineageCall(env, lineage, "DELETE"); }
  catch (e) { if (!(e instanceof TierError)) throw e; cleanup = { deleted: false, status: e.status, code: e.code }; }
  const error = failure && { status: failure.status, code: failure.code, op: failure.op };
  return { ok: !failure && cleanup.deleted, lineage, iterations, completed, window, routes, statuses, cleanup, ...(error ? { error } : {}) };
}

export async function handleCamelfsSmoke(request: Request, env: TierEnv & { ADMIN_TENANTS?: string }, auth: { tenantId: string; scopes: string[] }) {
  if (!tierConfigured(env) || request.method !== "POST") return new Response(null, { status: 404 });
  const admins = (env.ADMIN_TENANTS ?? "").split(",").map(value => value.trim());
  if (!admins.includes(auth.tenantId) || !auth.scopes.includes("*"))
    return Response.json({ error: "Admin account required", code: "FORBIDDEN" }, { status: 403 });
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return new Response(null, { status: 403 });
  const params = new URL(request.url).searchParams;
  const iterations = Number(params.get("iterations") ?? "1"), minSeconds = Number(params.get("minSeconds") ?? "0");
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 500)
    return Response.json({ error: "iterations must be 1..500", code: "INVALID_REQUEST" }, { status: 400 });
  if (!Number.isSafeInteger(minSeconds) || minSeconds < 0 || minSeconds > 600)
    return Response.json({ error: "minSeconds must be 0..600", code: "INVALID_REQUEST" }, { status: 400 });
  try {
    const result = await camelfsSmoke(env, iterations, minSeconds, auth.tenantId);
    return Response.json(result, { status: result.ok ? 200 : 502, headers: { "cache-control": "no-store" } });
  }
  catch (e) {
    if (!(e instanceof TierError)) throw e;
    const { status, code, message, details, op } = e;
    return Response.json({ error: { status, code, message, details, op } }, { status, headers: { "cache-control": "no-store" } });
  }
}
