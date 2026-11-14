import { randomUUID } from "node:crypto";
import { tierConfigured, TierError, type TierEnv } from "./tier.ts";
import { StorageError } from "../repos/storage.ts";
import { repoStorage } from "./repo-storage.ts";

const ROUTES = ["putBlob", "commit", "readBatch", "getCommit"] as const;
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/** One round on a throwaway lineage: PUT blob, POST commit (1 file), batch read, GET commit. `wall` collects each
 * fetch's duration by route (ledger L89 measures Worker -> tier wall time against the tier's server-side ms). */
async function smokeRound(env: TierEnv, lineage: string, round: number, wall: Record<string, number[]>) {
  const path = "probe.txt", sub = "runtime:camelfs-smoke";
  const bytes = new TextEncoder().encode(`${lineage}:${round}`);
  const storage = repoStorage(env, sub);
  async function measure<T>(op: (typeof ROUTES)[number], run: () => Promise<T>) {
    const start = performance.now();
    try { return await run(); }
    catch (e) {
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
export async function camelfsSmoke(env: TierEnv, iterations = 1) {
  const lineage = "smoke:" + randomUUID(), wall = Object.fromEntries(ROUTES.map(r => [r, [] as number[]])) as Record<string, number[]>;
  for (let round = 0; round < iterations; round++) await smokeRound(env, lineage, round, wall);
  const routes = Object.fromEntries(ROUTES.map(route => {
    const sorted = [...wall[route]].sort((a, b) => a - b);
    return [route, { count: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99) }];
  }));
  return { ok: true, lineage, iterations, routes };
}

export async function handleCamelfsSmoke(request: Request, env: TierEnv & { ADMIN_TENANTS?: string }, auth: { tenantId: string; scopes: string[] }) {
  if (!tierConfigured(env) || request.method !== "POST") return new Response(null, { status: 404 });
  const admins = (env.ADMIN_TENANTS ?? "").split(",").map(value => value.trim());
  if (!admins.includes(auth.tenantId) || !auth.scopes.includes("*"))
    return Response.json({ error: "Admin account required", code: "FORBIDDEN" }, { status: 403 });
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return new Response(null, { status: 403 });
  const raw = new URL(request.url).searchParams.get("iterations") ?? "1", iterations = Number(raw);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 500)
    return Response.json({ error: "iterations must be 1..500", code: "INVALID_REQUEST" }, { status: 400 });
  try { return Response.json(await camelfsSmoke(env, iterations), { headers: { "cache-control": "no-store" } }); }
  catch (e) {
    if (!(e instanceof TierError)) throw e;
    const { status, code, message, details, op } = e;
    return Response.json({ error: { status, code, message, details, op } }, { status, headers: { "cache-control": "no-store" } });
  }
}
