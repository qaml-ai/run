/**
 * The Workers backend for the memory benchmark, on local workerd (Wrangler, as backends/workers/test/fixture.ts runs it)
 * or on celld (`celld dev`). Both run the production entry, backends/workers/src/index.ts, not the contract test
 * wrapper (which reads its tenant configuration from Postgres on every request), with the same variables.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { fakeModel } from "../../tests/runtime-server.ts";

type T = { after(fn: () => Promise<void> | void): void };
type Reply = (body: any, index: number) => object;
const workersRoot = fileURLToPath(new URL("../../backends/workers/", import.meta.url));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** What the contract fixture gives the Worker (tests/contract/fixtures/workers.ts), minus its test-only wrapper. */
function vars(modelUrl: string, tenants: object, internal: string, publicUrl: string) {
  return {
    AGENT_SESSION_SECRET: "server-test-session-secret-with-32-chars",
    AGENT_SECRETS_KEY: "0".repeat(64),
    AGENT_PUBLIC_URL: publicUrl,
    AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: modelUrl,
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.0/8,::1/128",
    AGENT_MAX_AGENTS_PER_TENANT: "100000",
    API_TOKEN: internal, DEFAULT_TENANT: "alice",
    AGENT_TENANTS_JSON: JSON.stringify(tenants),
    TEST_MODE: "1", TEST_MODEL: "1", MODEL: "openrouter/openai/gpt-4o-mini",
    TEST_MODEL_API: "openai-completions", TEST_MODEL_BASE_URL: modelUrl,
    FILE_SIGNING_SECRET: "local-only-file-secret-with-at-least-32-characters",
    ALLOW_LOCAL_WEBHOOKS: "1",
  };
}

function client(base: string, token: string) {
  return async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(base + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { Authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let json: any = text; try { json = JSON.parse(text); } catch {}
    return { status: response.status, json, text };
  };
}

export async function createWorkerdFixture(t: T, options: { respond: Reply; tenants: object; operator: string }) {
  const model = await fakeModel(t, options.respond);
  const { startFixture } = await import(new URL("../../backends/workers/test/fixture.ts", import.meta.url).href);
  const internal = `bench-internal-${randomBytes(12).toString("hex")}`;
  const server = await startFixture({ token: internal, tenant: "alice", tenants: [], modelURL: model.url,
    vars: vars(model.url, options.tenants, internal, "") });
  t.after(() => server.stop());
  return { call: client(server.url, options.operator), close: async () => {}, logs: () => server.worker.logs().split("\n") };
}

async function freePort() {
  const s = createServer(); s.listen(0, "127.0.0.1");
  await new Promise(r => s.once("listening", r));
  const port = (s.address() as { port: number }).port; s.close(); return port;
}

/**
 * celld dev: one node, its local object store, the same Worker. Substitutions, all forced by celld's Wrangler subset
 * (https://celld.dev/docs/cloudflare-compat): HYPERDRIVE becomes a plain object variable holding the same direct local
 * connection string Hyperdrive's local mode uses; IMAGES and METRICS (Analytics Engine) are dropped (the benchmark sends
 * no images; METRICS is optional in the code); the code mode sandbox, a separate Worker on Cloudflare, is exported from
 * the same Worker (celld runs one application per fleet); `build`, `observability`, `workers_dev`, `preview_urls` go.
 */
export async function createCelldFixture(t: T, options: { respond: Reply; tenants: object; operator: string; env?: Record<string, string> }) {
  const model = await fakeModel(t, options.respond);
  const base = process.env.AGENT_TEST_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:55432/postgres";
  const { createMigratedDatabase } = await import(new URL("../../backends/workers/test/migrated-database.ts", import.meta.url).href);
  const admin = new pg.Client({ connectionString: base }); await admin.connect();
  const name = `celld_${randomBytes(6).toString("hex")}`;
  await createMigratedDatabase(admin, base, name);
  t.after(async () => { await admin.query(`drop database ${name} with (force)`); await admin.end(); });
  const url = new URL(base); url.pathname = `/${name}`; url.search = "";
  if (!url.password) url.password = "local-only-unused";
  const internal = `bench-internal-${randomBytes(12).toString("hex")}`;
  const db = new pg.Client({ connectionString: url.href }); await db.connect();
  await db.query("insert into tenants(id,created_at,billing) values('alice',$1,'prepaid') on conflict do nothing", [Date.now()]);
  await db.query("insert into api_tokens(sha256,id,tenant,name,prefix,created_at) values($1,$2,'alice','bench','bench',$3) on conflict do nothing",
    [createHash("sha256").update(internal).digest("hex"), crypto.randomUUID(), Date.now()]);
  await db.end();

  const port = await freePort();
  // celld wants `main` inside the project directory: the generated config sits beside the entry (celld/, gitignored).
  const dir = fileURLToPath(new URL("./celld/", import.meta.url));
  await rm(join(dir, ".celld"), { recursive: true, force: true });
  const { publicAssets } = await import(new URL("../../backends/workers/scripts/public-assets.mjs", import.meta.url).href);
  await publicAssets(join(dir, "public"), {});
  const entry = "entry.ts";
  const config = {
    name: "camelrun-celld-bench", main: entry, compatibility_date: "2026-11-05",
    compatibility_flags: ["nodejs_compat", "enable_request_signal"],
    assets: { directory: "public", binding: "PUBLIC_ASSETS", run_worker_first: true, html_handling: "none", not_found_handling: "none" },
    durable_objects: { bindings: [
      { name: "AGENTS", class_name: "CamelAgent" }, { name: "TENANTS", class_name: "TenantAdmission" },
      { name: "VOLUMES", class_name: "Volume" }, { name: "CODEMODE_SANDBOX", class_name: "CodemodeSandbox" },
    ] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["CamelAgent", "TenantAdmission", "Volume", "CodemodeSandbox"] }],
    r2_buckets: [{ binding: "BUCKET", bucket_name: "camelrun-celld-files" }],
    queues: { producers: [{ binding: "WEBHOOKS", queue: "camelrun-celld-webhooks" }],
      consumers: [{ queue: "camelrun-celld-webhooks", max_batch_size: 1, max_batch_timeout: 1, max_retries: 3 }] },
    triggers: { crons: ["*/5 * * * *", "* * * * *"] },
    vars: { ...vars(model.url, options.tenants, internal, `http://127.0.0.1:${port}`), HYPERDRIVE_URL: url.href },
  };
  const configPath = join(dir, "wrangler.jsonc");
  await writeFile(configPath, JSON.stringify(config, null, 1));
  await mkdir(join(dir, ".celld"), { recursive: true });
  const child = spawn(process.env.CELLD ?? "celld", ["dev", configPath, "--port", String(port), "--host", "127.0.0.1", "--no-watch", "--logs"], {
    cwd: dir, env: { ...process.env, PATH: `${join(workersRoot, "node_modules/.bin")}:${process.env.PATH}`, CELLD_ESBUILD: join(dir, "esbuild-wrapper.sh"), ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  // BENCH_CELLD_LOG: also keep the node's whole log in a file.
  const file = process.env.BENCH_CELLD_LOG ? createWriteStream(process.env.BENCH_CELLD_LOG) : undefined;
  const save = (d: Buffer) => { logs = (logs + d.toString()).slice(-200_000); file?.write(d); };
  child.stdout.on("data", save); child.stderr.on("data", save);
  t.after(async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise(r => child.once("exit", r)); } });
  const call = client(`http://127.0.0.1:${port}`, options.operator);
  const deadline = Date.now() + 300_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`celld exited ${child.exitCode}\n${logs.slice(-5000)}`);
    try { const r = await call("/v1/agents?limit=1"); if (r.status < 500) break; } catch {}
    if (Date.now() > deadline) throw new Error(`celld did not start\n${logs.slice(-5000)}`);
    await sleep(500);
  }
  return { call, close: async () => {}, logs: () => logs.split("\n"), pid: child.pid };
}
