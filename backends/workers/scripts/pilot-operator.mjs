import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PILOT_ACCOUNT = "85bbd288051330fb51ee1c86031a299b";
export const PILOT_URL = "https://run-pilot.camelai.dev";
export const PILOT_HYPERDRIVE = "3e6d68e844ec480589e766119f52dead";
const workers = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function wrangler(args, directory) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(workers, "node_modules/wrangler/bin/wrangler.js"), ...args], {
      cwd: workers,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: PILOT_ACCOUNT, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_SANITIZE: "true", WRANGLER_LOG: "log", WRANGLER_LOG_PATH: join(directory, "wrangler.log"), CI: "true" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes; });
    child.stderr.on("data", bytes => { output += bytes; });
    child.stdin.end("y\n");
    child.on("error", () => reject(new Error("Could not start the repository's Wrangler. Run npm ci in backends/workers first.")));
    child.on("exit", code => code === 0 ? resolveRun(output) : reject(new Error(`Pilot bootstrap ${args[0]} failed (exit ${code}); inspect Cloudflare permissions and the pilot deployment.`)));
  });
}

/** Deploy a short-lived Worker in the pilot account, run callback({ baseUrl,
 * token, request, workerName }) against it, and delete it in finally. The token
 * stays in process memory; entry(tokenHash, expiresAt) returns the Worker's
 * entry source, which may hold only the hash. The credential expires after one
 * hour even if the deletion fails. `warm` lists GET paths that must answer
 * before the callback runs (routing and Hyperdrive warm-up). */
export async function withTemporaryWorker({ prefix, entry: entrySource, bindings, warm = ["/healthz"], label = "Pilot operator" }, callback) {
  const token = randomBytes(32).toString("hex");
  const name = `${prefix}-${randomBytes(5).toString("hex")}`;
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const configPath = join(directory, "wrangler.json");
  const entry = join(directory, "entry.ts");
  await writeFile(entry, entrySource(createHash("sha256").update(token).digest("hex"), Date.now() + 3_600_000));
  const config = {
    name, account_id: PILOT_ACCOUNT, main: entry, compatibility_date: "2026-11-05", compatibility_flags: ["nodejs_compat"],
    workers_dev: true, preview_urls: false,
    // Request bodies and Authorization headers are not recorded; no tail is opened.
    observability: { enabled: false },
    ...bindings,
  };
  await writeFile(configPath, JSON.stringify(config, null, 2));
  let uploaded = false;
  try {
    let output;
    try { output = await wrangler(["deploy", "--config", configPath], directory); }
    catch {
      // An upload can succeed before a later deployment step fails.
      try { await wrangler(["delete", name, "--config", configPath], directory); }
      catch { throw new Error(`${label} deploy failed; check and delete ${name} in account ${PILOT_ACCOUNT} if it remains. Its credential expires within one hour.`); }
      throw new Error(`${label} deployment failed; ${name} was removed.`);
    }
    uploaded = true;
    const baseUrl = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/)?.[0];
    if (!baseUrl) throw new Error(`Could not determine ${name}'s workers.dev URL.`);
    const request = async (path, init = {}) => {
      const { body, ...rest } = init;
      const response = await fetch(`${baseUrl}${path}`, {
        ...rest, method: rest.method ?? (body === undefined ? "GET" : "POST"),
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...rest.headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: rest.signal ?? AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        // Diagnose routing without echoing response content, credentials or queries.
        const final = new URL(response.url);
        const contentType = response.headers.get("content-type") ?? "unknown";
        const data = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
        const known = new Set(["Not found", "Pilot operator request failed", "Tenant outside bootstrap scope", "Agent outside bootstrap scope", "Bootstrap expired", "Unauthorized",
          "Pilot migration request failed", "Migration failed", "Database is ahead of this checkout"]);
        const category = known.has(data?.error) ? data.error : "unclassified";
        // Only the migration Worker sends these: migration names and SQLSTATE codes.
        const detail = ["migration", "code", "applied", "unknown"].filter(key => data?.[key] != null).map(key => `; ${key}=${JSON.stringify(data[key])}`).join("");
        throw new Error(`${label} ${init.method ?? (body === undefined ? "GET" : "POST")} ${new URL(path, PILOT_URL).pathname} failed (${response.status}); category=${category}${detail}; type=${contentType}; target=${final.host}${final.pathname}; redirected=${response.redirected}; ray=${response.headers.get("cf-ray") ?? "none"}.`);
      }
      return response.json();
    };
    for (let attempt = 0; ; attempt++) {
      try { for (const path of warm) await request(path); break; }
      catch (error) { if (attempt === 19) throw error; await new Promise(resolveWait => setTimeout(resolveWait, 1000)); }
    }
    return await callback({ baseUrl, token, request, workerName: name });
  } finally {
    try {
      if (uploaded) await wrangler(["delete", name, "--config", configPath], directory);
    } catch {
      throw new Error(`${label} cleanup failed. Delete the temporary Worker ${name} in account ${PILOT_ACCOUNT}; its credential expires within one hour.`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

/** Credentials stay in process memory. The temporary Worker holds only a hash,
 * is limited to tenantIds, expires after one hour, and is deleted in finally.
 * callback results must not include credentials unless the caller is the CTO's
 * interactive, one-time key command. */
export async function withPilotOperator(options, callback) {
  const tenantIds = options.tenantIds ?? options.tenants;
  if (!Array.isArray(tenantIds) || !tenantIds.length || tenantIds.length > 100 || tenantIds.some(id => !/^pilot-[a-z0-9-]{1,33}$/.test(id)))
    throw new Error("Bootstrap requires 1–100 explicit pilot-* tenant IDs (at most 39 characters).");
  return withTemporaryWorker({
    prefix: "camelrun-pilot-bootstrap",
    label: "Pilot bootstrap",
    entry: (tokenHash, expiresAt) => `import createOperator from ${JSON.stringify(join(workers, "scripts/pilot-operator-worker.ts"))};\nexport default createOperator(${JSON.stringify({ tokenHash, tenantIds, expiresAt })});\n`,
    bindings: {
      hyperdrive: [{ binding: "HYPERDRIVE", id: PILOT_HYPERDRIVE }],
      r2_buckets: [{ binding: "BUCKET", bucket_name: "camelrun-pilot-files" }],
      queues: { producers: [{ binding: "WEBHOOKS", queue: "camelrun-pilot-delivery" }] },
      durable_objects: { bindings: [
        { name: "AGENTS", class_name: "CamelAgent", script_name: "camelrun-pilot" },
        { name: "TENANTS", class_name: "TenantAdmission", script_name: "camelrun-pilot" },
      ] },
    },
    // Warm both routing and Hyperdrive with reads before attempting a mutation.
    warm: ["/healthz", "/pilot/inspect"],
  }, callback);
}
