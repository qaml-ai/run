import { randomUUID } from "node:crypto";
import { tierConfigured, TierError, type TierEnv } from "./tier.ts";
import { camelfsStorage, StorageError } from "../repos/storage.ts";

export async function camelfsSmoke(env: TierEnv) {
  const lineage = "smoke:" + randomUUID(), path = "probe.txt", sub = "runtime:camelfs-smoke";
  const bytes = new TextEncoder().encode(lineage);
  const storage = camelfsStorage(env, sub);
  const timings: Record<string, number> = {};
  async function measure<T>(op: string, run: () => Promise<T>) {
    const start = performance.now();
    try { return await run(); }
    catch (e) {
      if (e instanceof StorageError) throw new TierError(e.status || 502, e.code, e.reason, e.details, op);
      throw e;
    } finally { timings[op] = performance.now() - start; }
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
  return { ok: true, lineage, commit: commit.commit, timings };
}

export async function handleCamelfsSmoke(request: Request, env: TierEnv & { ADMIN_TENANTS?: string }, auth: { tenantId: string; scopes: string[] }) {
  if (!tierConfigured(env) || request.method !== "POST") return new Response(null, { status: 404 });
  const admins = (env.ADMIN_TENANTS ?? "").split(",").map(value => value.trim());
  if (!admins.includes(auth.tenantId) || !auth.scopes.includes("*"))
    return Response.json({ error: "Admin account required", code: "FORBIDDEN" }, { status: 403 });
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return new Response(null, { status: 403 });
  try { return Response.json(await camelfsSmoke(env), { headers: { "cache-control": "no-store" } }); }
  catch (e) {
    if (!(e instanceof TierError)) throw e;
    const { status, code, message, details, op } = e;
    return Response.json({ error: { status, code, message, details, op } }, { status, headers: { "cache-control": "no-store" } });
  }
}
