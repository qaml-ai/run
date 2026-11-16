#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PILOT_ACCOUNT, withTemporaryWorker } from "./pilot-operator.mjs";

const SCRIPT = "camelrun-pilot";
const CLASS = "ContainerComputer";
const NAMESPACE = "2530c7f9f1544cf59711c6d5ff5a1a8d";
const OBJECT_ID = /^[0-9a-f]{64}$/;
const CONCURRENCY = 8;

async function cloudflareGet(url, token, send) {
  const res = await send(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!res?.ok) throw new Error(`Cloudflare inventory request failed (${res?.status ?? "network error"}).`);
  const page = await res.json().catch(() => null);
  if (page?.success !== true) throw new Error("Cloudflare returned an invalid inventory response.");
  return page;
}

async function inventory(accountApi, token, send) {
  const objects = new Map(), cursors = new Set();
  let cursor;
  do {
    const url = new URL(`${accountApi}/workers/durable_objects/namespaces/${NAMESPACE}/objects`);
    url.searchParams.set("limit", "500");
    if (cursor) url.searchParams.set("cursor", cursor);
    const page = await cloudflareGet(url, token, send);
    if (!Array.isArray(page.result)) throw new Error("Cloudflare returned an invalid inventory page.");
    for (const object of page.result) {
      if (typeof object?.id !== "string" || !OBJECT_ID.test(object.id))
        throw new Error("Cloudflare returned an invalid Durable Object ID.");
      objects.set(object.id, object.hasStoredData === true || objects.get(object.id) === true);
    }
    cursor = page.result_info?.cursor ?? page.result_info?.cursors?.after;
    if (cursor && (typeof cursor !== "string" || cursors.has(cursor))) throw new Error("Cloudflare did not advance the inventory cursor.");
    if (cursor) cursors.add(cursor);
    if (!cursor && page.result_info?.total_count > objects.size)
      throw new Error("Cloudflare inventory ended before all Durable Objects were listed.");
  } while (cursor);
  return objects;
}

// Serialized into the temporary Worker's entrypoint. It contains no usable credential.
function drainWorker(tokenHash, expiresAt) {
  const reply = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
  return {
    async fetch(request, env) {
      if (Date.now() > expiresAt) return reply({ error: "Bootstrap expired" }, 410);
      const token = request.headers.get("Authorization")?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
      if (!token) return reply({ error: "Unauthorized" }, 401);
      const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
      if (!timingSafeEqual(hash, Buffer.from(tokenHash, "hex"))) return reply({ error: "Unauthorized" }, 401);
      const path = new URL(request.url).pathname;
      if (path === "/healthz" && request.method === "GET") return reply({ ok: true });
      const id = /^\/drain\/([0-9a-f]{64})$/.exec(path)?.[1];
      if (!id || request.method !== "POST") return reply({ error: "Not found" }, 404);
      try {
        const ns = env.COMPUTER_CONTAINERS;
        const result = await ns.get(ns.idFromString(id)).drain();
        if (result.settled === true) return reply({ status: "settled" });
        return reply({ status: result.settled === false ? "pending" : "rpc_failed" });
      } catch {
        return reply({ status: "rpc_failed" });
      }
    },
  };
}

export async function drainPilotComputers({
  token, confirm = false, send = fetch, withWorker = withTemporaryWorker, log = console.log,
  api = process.env.CLOUDFLARE_API_BASE_URL || "https://api.cloudflare.com/client/v4",
}) {
  if (!token?.trim()) throw new Error("Set CLOUDFLARE_API_TOKEN with pilot Workers read access. Applying the drain also needs Workers write access.");
  const accountApi = `${api.replace(/\/$/, "")}/accounts/${PILOT_ACCOUNT}`;
  const settings = await cloudflareGet(new URL(`${accountApi}/workers/scripts/${SCRIPT}/settings`), token, send);
  const binding = settings.result?.bindings?.find(value => value.name === "COMPUTER_CONTAINERS");
  if (binding?.class_name !== CLASS || binding.namespace_id !== NAMESPACE)
    throw new Error("The deployed pilot does not bind the expected legacy computer namespace.");
  const objects = await inventory(accountApi, token, send);
  const withStorage = [...objects.values()].filter(Boolean).length;
  log(`${SCRIPT}/${CLASS} (${NAMESPACE}): ${objects.size} objects, ${withStorage} with stored data.`);
  if (!confirm || !objects.size) return { objects: objects.size, withStorage };
  const failures = await withWorker({
    prefix: "camelrun-pilot-computer-drain",
    label: "Pilot computer drain",
    entry: (tokenHash, expiresAt) => `import { timingSafeEqual } from "node:crypto";\nexport default (${drainWorker})(${JSON.stringify(tokenHash)}, ${expiresAt});\n`,
    bindings: { durable_objects: { bindings: [{ name: "COMPUTER_CONTAINERS", class_name: CLASS, script_name: SCRIPT }] } },
  }, async ({ request }) => {
    const iterator = objects.keys(), failures = [];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (const id of iterator) {
        const result = await request(`/drain/${id}`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        }).catch(() => null);
        if (result?.status === "settled") continue;
        const status = result?.status === "pending" ? "pending" : "rpc_failed";
        failures.push({ id, status });
        log(`${id}: ${status}`);
      }
    }));
    return failures;
  });
  log(`${objects.size - failures.length}/${objects.size} settled.`);
  return { objects: objects.size, withStorage, failures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 1 || args[0] !== "--confirm")) {
    console.error("Usage: node backends/workers/scripts/pilot-drain-computers.mjs [--confirm]");
    process.exitCode = 2;
  } else {
    try {
      const result = await drainPilotComputers({ token: process.env.CLOUDFLARE_API_TOKEN, confirm: args.length === 1 });
      if (result.failures?.length) {
        console.error("Some objects did not settle. Check pilot logs, then rerun --confirm to retry.");
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
