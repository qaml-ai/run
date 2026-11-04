import { readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const number = value => Math.round(value * 1000) / 1000;
export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0 };
  const percentile = fraction => number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]);
  return { n: sorted.length, min: number(sorted[0]), p50: percentile(0.5), p95: percentile(0.95),
    max: number(sorted.at(-1)), mean: number(sorted.reduce((a, b) => a + b, 0) / sorted.length) };
}

export async function runBench({ url, token, samples = 12, concurrency = 50 }) {
  const origin = new URL(url).origin;
  const runId = `cm-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const request = async (path, input, authenticated = true) => {
    const start = performance.now();
    const response = await fetch(`${origin}${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        ...(input === undefined ? {} : { "content-type": "application/json" }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(25_000),
    });
    // Never copy arbitrary server error pages, headers, or credentials into evidence.
    const data = response.ok ? await response.json() : null;
    return { httpStatus: response.status, httpMs: number(performance.now() - start), data };
  };
  const status = caller => request(`/bench/${caller}/status`);
  const execute = (caller, name) => request(`/bench/${caller}/run`, { case: name });
  const summarize = rows => ({
    requests: rows.length,
    successful: rows.filter(row => row.httpStatus === 200 && row.data?.result?.ok).length,
    httpMs: distribution(rows.map(row => row.httpMs)),
    wallMs: distribution(rows.map(row => row.data?.wallMs)),
    firstToolAtMs: distribution(rows.map(row => row.data?.firstToolAtMs)),
  });

  const health = await request("/healthz");
  if (health.httpStatus !== 200) throw new Error(`Authenticated health check returned HTTP ${health.httpStatus}`);
  const authentication = {};
  for (const path of ["/healthz", `/bench/${runId}-unauth/status`, `/bench/${runId}-unauth/run`, "/unknown"]) {
    const result = await request(path, path.endsWith("/run") ? { case: "start" } : undefined, false);
    authentication[path.replace(runId, "RUN")] = result.httpStatus;
  }

  const cold = [];
  for (let index = 0; index < samples; index++) cold.push(await execute(`${runId}-cold-${index}`, "start"));
  const warmCaller = `${runId}-warm`;
  const warmup = await execute(warmCaller, "start");
  const warm = [];
  for (let index = 0; index < samples; index++) warm.push(await execute(warmCaller, "start"));
  const nested = [];
  for (let index = 0; index < samples; index++) nested.push(await execute(warmCaller, "nested"));
  const nestedRoundTrips = nested.flatMap(row => {
    const callbacks = row.data?.callbacks ?? [];
    return callbacks.slice(1).map((callback, index) => callback.atMs - callbacks[index].atMs);
  });

  const batches = [];
  for (const layout of ["same-caller", "independent-callers"]) {
    const start = performance.now();
    const rows = await Promise.all(Array.from({ length: concurrency }, (_, index) =>
      execute(`${runId}-${layout}${layout === "same-caller" ? "" : `-${index}`}`, "nested")));
    const elapsedMs = number(performance.now() - start);
    batches.push({ layout, elapsedMs, executionsPerSecond: number(concurrency / elapsedMs * 1000),
      summary: summarize(rows), rows });
  }

  const safety = [];
  for (const name of ["loop", "memory", "pending", "throw", "tool"]) {
    const caller = `${runId}-safety-${name}`;
    await execute(caller, "start");
    const before = await status(caller);
    let settled = false;
    const execution = execute(caller, name).finally(() => { settled = true; });
    const probes = [];
    while (!settled) {
      probes.push(await status(caller));
      if (!settled) await delay(20);
    }
    const result = await execution;
    const after = await status(caller);
    const recovery = await execute(caller, "start");
    const activeProbes = probes.filter(probe => probe.data?.active > 0);
    const markedActiveProbes = activeProbes.filter(probe => probe.data.marked > before.data.marked);
    safety.push({ case: name, result, probes, before, after, recovery,
      failedAsExpected: result.httpStatus === 200 && result.data?.result?.ok === false,
      callerInstancePreserved: before.data?.instanceId === after.data?.instanceId &&
        before.data?.instanceId === recovery.data?.after?.instanceId,
      recovered: recovery.httpStatus === 200 && recovery.data?.result?.ok === true && recovery.data.result.value === 1,
      activeProbeMs: distribution(activeProbes.map(probe => probe.httpMs)),
      markedActiveProbeMs: distribution(markedActiveProbes.map(probe => probe.httpMs)),
    });
  }

  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), origin, runId, samples, concurrency,
    measurements: {
      cold: summarize(cold), warm: summarize(warm), nested: summarize(nested),
      nestedRoundTripMs: distribution(nestedRoundTrips),
      batches: batches.map(({ rows, ...batch }) => batch),
      safety: safety.map(({ case: name, result, probes, before, after, recovery, ...summary }) =>
        ({ case: name, ...summary, error: result.data?.result?.error })),
    },
    authentication, raw: { health, cold, warmup, warm, nested, batches, safety },
    limits: {
      remoteMemoryBytes: 32 * 1024 * 1024, remoteInterruptPolls: 100_000,
      callerTimeoutMs: 15_000, workerCpuLimitMs: 30_000,
    },
    interpretation: [
      "Cold means fresh caller and sandbox DO names, not a guaranteed cold Cloudflare isolate or uncached Worker bundle.",
      "firstToolAtMs includes remote RPC, VM creation, initial script work, and its first callback to the caller; it is an upper bound on script readiness.",
      "Nested round trips use differences between callback arrival times for a sequential 20-tool chain; host echo work is trivial.",
      "Client timings include network travel. Worker Date.now timings are coarse and can remain static during synchronous computation.",
      "The caller is a small benchmark DO using the same stock remote sandbox, not a full PiHarness agent; there are no model calls.",
      "Compatibility process metrics can be absent, zero, or isolate-wide. They do not establish per-DO CPU, heap, RSS, or billed usage.",
      "Marked active probes establish responsiveness during remote script work. Very short failures may finish before any probe arrives.",
      "A caller deadline ends its wait; remote computation stops at its next callback or interrupt poll budget. Recovery does not prove immediate remote cancellation.",
    ],
  };
}

async function main() {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    if (!["--url", "--token-file", "--out", "--samples", "--concurrency"].includes(key) || !process.argv[index + 1]) {
      throw new Error("Usage: node bench/codemode-run.mjs --url URL --token-file .state/api-token --out FILE [--samples 12] [--concurrency 50]");
    }
    options[key.slice(2)] = process.argv[index + 1];
  }
  if (!options.url || !options["token-file"] || !options.out) throw new Error("--url, --token-file, and --out are required");
  const tokenPath = resolve(options["token-file"]);
  if (((await stat(tokenPath)).mode & 0o077) !== 0) throw new Error("Token file must be private (chmod 600)");
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (token.length < 32 || /\s/.test(token)) throw new Error("Invalid token file");
  const samples = Number(options.samples ?? 12);
  const concurrency = Number(options.concurrency ?? 50);
  if (!Number.isInteger(samples) || samples < 1 || samples > 100 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) {
    throw new Error("samples must be 1..100 and concurrency must be 1..50");
  }
  const evidence = await runBench({ url: options.url, token, samples, concurrency });
  const serialized = JSON.stringify(evidence, null, 2);
  if (serialized.includes(token)) throw new Error("Refusing to save evidence containing credentials");
  await writeFile(options.out, `${serialized}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ output: resolve(options.out), measurements: evidence.measurements, authentication: evidence.authentication }, null, 2));
  if (Object.values(evidence.authentication).some(status => status !== 401) ||
      [evidence.measurements.cold, evidence.measurements.warm, evidence.measurements.nested].some(row => row.successful !== samples) ||
      evidence.raw.nested.some(row => row.data?.result?.value !== 20) ||
      evidence.measurements.batches.some(batch => batch.summary.successful !== concurrency) ||
      evidence.measurements.safety.some(row => !row.failedAsExpected || !row.callerInstancePreserved || !row.recovered)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Benchmark failed"); process.exitCode = 1; });
}
