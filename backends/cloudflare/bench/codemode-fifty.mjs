import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { distribution } from "./codemode-run.mjs";

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  assert.ok(["--url", "--token-file", "--out"].includes(key) && value, "Use --url URL --token-file PATH --out FILE");
  options[key.slice(2)] = value;
}
assert.ok(options.url && options["token-file"] && options.out, "Use --url URL --token-file PATH --out FILE");
const tokenPath = resolve(options["token-file"]);
assert.equal((await stat(tokenPath)).mode & 0o077, 0, "Token file must be private");
const token = (await readFile(tokenPath, "utf8")).trim();
assert.ok(token.length >= 32 && !/\s/.test(token), "Invalid token file");
const origin = new URL(options.url).origin;
const caller = `cm-fifty-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const rows = [];
for (let index = 0; index < 3; index++) {
  const start = performance.now();
  const response = await fetch(`${origin}/bench/${caller}/run`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ case: "nested50" }), signal: AbortSignal.timeout(25_000),
  });
  const data = response.ok ? await response.json() : null;
  rows.push({ sample: index, httpStatus: response.status, httpMs: performance.now() - start, data });
}
const valid = rows.every(row => row.httpStatus === 200 && row.data?.result?.ok === true && row.data.result.value === 50 &&
  row.data.callbacks?.length === 51 && row.data.callbacks[0].name === "mark" && row.data.callbacks.slice(1).every(callback => callback.name === "echo"));
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), origin, caller, case: "nested50",
  samples: 3, sequentialEchoCallsPerSample: 50, additionalMarkCallsPerSample: 1, valid,
  measurements: {
    httpMs: distribution(rows.map(row => row.httpMs)),
    wallMs: distribution(rows.map(row => row.data?.wallMs)),
    firstToolAtMs: distribution(rows.map(row => row.data?.firstToolAtMs)),
    callbackRoundTripMs: distribution(rows.flatMap(row => (row.data?.callbacks ?? []).slice(1).map((callback, index) => callback.atMs - row.data.callbacks[index].atMs))),
  },
  rows,
  interpretation: [
    "Exactly 50 sequential echo callbacks plus one start marker per script; three scripts run sequentially on one caller/sandbox.",
    "The first sample may initialize the named objects; fresh object names do not prove a cold Worker isolate.",
    "Arrival-time differences include remote dispatch and trivial host echo work. They are wall time, not active CPU.",
    "This is a deterministic stock remote codemode benchmark and uses no model calls.",
  ],
};
const output = `${JSON.stringify(report, null, 2)}\n`;
assert.ok(!output.includes(token), "Refusing to save credentials");
await writeFile(options.out, output, { mode: 0o600 });
console.log(JSON.stringify({ output: resolve(options.out), valid, measurements: report.measurements }));
if (!valid) process.exitCode = 1;
