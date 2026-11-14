import { DurableObject } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { tierConfigured, TierError, tierRequest, type TierEnv } from "./tier.ts";
import { StorageError } from "../repos/storage.ts";
import { fetchWithoutRedirects } from "../../../../src/core/no-redirect.ts";
import { repoStorage } from "./repo-storage.ts";

const SMOKE_SUB = "runtime:camelfs-smoke";
const SMOKE_REF = "main";
const LOCATION_HINTS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"] as const satisfies readonly DurableObjectLocationHint[];
const NO_STORE = { "cache-control": "no-store" };
type SmokeEnv = TierEnv & { ADMIN_TENANTS?: string; CAMELFS_SMOKE?: DurableObjectNamespace<CamelfsSmoke> };
const ROUTES = ["putBlob", "commit", "write", "readBatch", "getCommit"] as const;
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

function timing(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99) };
}

export async function camelfsSmoke(env: TierEnv, iterations = 1, minSeconds = 0, tenant = "camelfs-smoke") {
  const lineage = "smoke:" + randomUUID();
  const path = "/v1/lineages/" + encodeURIComponent(lineage);
  const claims = { sub: SMOKE_SUB, lin: lineage, acc: "w" as const };
  const refClaims = { ...claims, refs: [SMOKE_REF] };
  const refPath = path + "/refs/" + SMOKE_REF;
  const meta = { author: SMOKE_SUB, message: "camelFS smoke", trailers: { "Camel-Op": "api" } };
  const storage = repoStorage(env, SMOKE_SUB);
  const wall = Object.fromEntries(ROUTES.map(route => [route, [] as number[]])) as Record<string, number[]>;
  const statuses = Object.fromEntries(ROUTES.map(route => [route, {} as Record<string, number>]));
  const twoCall: number[] = [];
  let completed = 0, failure: TierError | undefined, refCreated = false;
  let op: string = "seed";
  async function measure<T>(route: (typeof ROUTES)[number], run: () => Promise<T>) {
    op = route;
    const start = performance.now();
    const count = (status: string) => { statuses[route][status] = (statuses[route][status] ?? 0) + 1; };
    try { const value = await run(); count("ok"); return value; }
    catch (e) {
      count(e instanceof StorageError || e instanceof TierError ? String(e.status || 0) : "error");
      throw e;
    } finally { wall[route].push(performance.now() - start); }
  }

  await tierRequest(env, { method: "PUT", path, claims, body: { tenant, kind: "workspace", defaultBranch: SMOKE_REF } });
  let cleanup: { deleted: true } | { deleted: false; status: number; code: string; op: string } = { deleted: true };
  let window = { startedAt: "", endedAt: "" };
  try {
    const seed = await storage.commit(lineage, { ...meta, parents: [], changes: [] });
    op = "createRef";
    await tierRequest(env, {
      method: "POST", path: path + "/refs", claims: refClaims,
      body: { name: SMOKE_REF, version: seed.commit, owner: "api:camelfs-smoke" },
    });
    refCreated = true;
    let head = seed.commit;
    const began = Date.now();
    window.startedAt = new Date(began).toISOString();
    for (let round = 0; round < iterations || Date.now() - began < minSeconds * 1000; round++) {
      const file = "probe.txt";
      const bytes = Buffer.from(`${lineage}:${round}`);
      // Keep the two payloads the same size without warming the inline blob through the legacy route.
      const inline = `${lineage};${round}`;
      const blob = await measure("putBlob", () => storage.putBlob(lineage, bytes));
      await measure("commit", () => storage.commit(lineage, {
        ...meta, parents: [], changes: [{ path: file, blob: blob.blob }],
      }));
      twoCall.push(wall.putBlob[round] + wall.commit[round]);
      const result = await measure("write", () => tierRequest<{ version: string; tree: string }>(env, {
        method: "POST", path: refPath + "/write", claims: refClaims,
        body: { ...meta, time: Math.floor(Date.now() / 1000), expect: head, changes: [{ path: file, text: inline }] },
      }));
      head = result.version;
      const [entry] = await measure("readBatch", () => storage.readBatch(lineage, result.tree, [file]));
      if (!entry || !("bytes" in entry) || !Buffer.from(inline).equals(entry.bytes))
        throw new TierError(502, "read_mismatch", "camelFS smoke read did not match", undefined, op);
      const metadata = await measure("getCommit", () => storage.getCommit(lineage, result.version));
      if (metadata.tree !== result.tree)
        throw new TierError(502, "commit_mismatch", "camelFS smoke commit did not match", undefined, op);
      completed++;
    }
  } catch (e) {
    if (!(e instanceof TierError || e instanceof StorageError)) throw e;
    failure = new TierError(e.status || 502, e.code, "camelFS smoke failed", undefined, op, e);
  } finally {
    window.endedAt = new Date().toISOString();
    window.startedAt ||= window.endedAt;
    try {
      if (refCreated) await tierRequest(env, { method: "DELETE", path: refPath, claims: refClaims });
    } catch (e) {
      if (!(e instanceof TierError)) throw e;
      cleanup = { deleted: false, status: e.status, code: e.code, op: "deleteRef" };
    } finally {
      try { await tierRequest(env, { method: "DELETE", path, claims, idempotencyKey: `delete:${lineage}` }); }
      catch (e) {
        if (!(e instanceof TierError)) throw e;
        cleanup = { deleted: false, status: e.status, code: e.code, op: "deleteLineage" };
      }
    }
  }
  const routes = Object.fromEntries(ROUTES.map(route => [route, timing(wall[route])]));
  const error = failure && { status: failure.status, code: failure.code, op: failure.op };
  return {
    ok: !failure && cleanup.deleted, lineage, iterations, completed, window, routes, twoCall: timing(twoCall), statuses, cleanup,
    ...(error ? { error } : {}),
  };
}

async function smokeReply(env: TierEnv, iterations: number, minSeconds: number, tenant: string,
  location: { colo: string | null; rayColo?: string }) {
  try {
    const result = await camelfsSmoke(env, iterations, minSeconds, tenant);
    return Response.json({ ...result, ...location }, { status: result.ok ? 200 : 502, headers: NO_STORE });
  } catch (e) {
    if (!(e instanceof TierError)) throw e;
    const { status, code } = e;
    return Response.json({ error: { status, code, op: "createLineage" }, ...location }, { status, headers: NO_STORE });
  }
}

export class CamelfsSmoke extends DurableObject<TierEnv> {
  async run(iterations: number, minSeconds: number, tenant: string): Promise<Response> {
    let colo: string | undefined, rayColo: string | undefined;
    try {
      const trace = await fetchWithoutRedirects(fetch, "https://www.cloudflare.com/cdn-cgi/trace", {
        cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
      if (trace.ok) {
        const body = await trace.text();
        colo = /^colo=([A-Z]{3})$/m.exec(body)?.[1];
        rayColo = /^[0-9a-f]+-([A-Z]{3})$/i.exec(trace.headers.get("cf-ray") ?? "")?.[1];
      }
    } catch {
      // A hinted run needs location evidence. Fail before creating a lineage.
    }
    if (!colo || !rayColo)
      return Response.json({ error: { status: 502, code: "trace_unavailable", op: "trace" } }, { status: 502, headers: NO_STORE });
    return smokeReply(this.env, iterations, minSeconds, tenant, { colo, rayColo });
  }
}

export async function handleCamelfsSmoke(request: Request, env: SmokeEnv, auth: { tenantId: string; scopes: string[] }) {
  if (!tierConfigured(env) || request.method !== "POST") return new Response(null, { status: 404 });
  const admins = (env.ADMIN_TENANTS ?? "").split(",").map(value => value.trim());
  if (!admins.includes(auth.tenantId) || !auth.scopes.includes("*"))
    return Response.json({ error: "Admin account required", code: "FORBIDDEN" }, { status: 403 });
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return new Response(null, { status: 403 });
  const params = new URL(request.url).searchParams;
  const iterations = Number(params.get("iterations") ?? "1"), minSeconds = Number(params.get("minSeconds") ?? "0");
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 600)
    return Response.json({ error: "iterations must be 1..600", code: "INVALID_REQUEST" }, { status: 400 });
  if (!Number.isSafeInteger(minSeconds) || minSeconds < 0 || minSeconds > 600)
    return Response.json({ error: "minSeconds must be 0..600", code: "INVALID_REQUEST" }, { status: 400 });
  const requestedHint = params.get("hint");
  if (requestedHint !== null) {
    const locationHint = LOCATION_HINTS.find(hint => hint === requestedHint);
    if (!locationHint)
      return Response.json({ error: `hint must be one of ${LOCATION_HINTS.join(", ")}`, code: "INVALID_REQUEST" }, { status: 400 });
    if (!env.CAMELFS_SMOKE)
      return Response.json({ error: "Hinted smoke is unavailable", code: "UNAVAILABLE" }, { status: 503, headers: NO_STORE });
    return env.CAMELFS_SMOKE.getByName(randomUUID(), { locationHint }).run(iterations, minSeconds, auth.tenantId);
  }
  const colo = typeof request.cf?.colo === "string" ? request.cf.colo : null;
  return smokeReply(env, iterations, minSeconds, auth.tenantId, { colo });
}
