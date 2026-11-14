// Post-flip compute smoke for the camel-fs bash tool (one agent, two VM boots, billing checked). Not part of the suite.
//
//   CAMELRUN_URL=https://<pilot> SMOKE_KEY_FILE=<file holding the key> node --experimental-strip-types scripts/smoke-compute.ts
//   (CAMELRUN_API_KEY=<key> instead of SMOKE_KEY_FILE also works)
//   (SMOKE_MODEL=<model id> to pick the agent's model; SMOKE_KEEP=1 keeps the test agent for inspection)
//
// It only creates, prompts, reads and finally deletes its own test agent; every other call is a read
// (usage, ledger). It never touches another agent, a setting or a balance.
//
// Steps, each asserted:
//   1. bash run 1: `echo hi`, the VM's boot_id, and a nonce written to /workspace/smoke.txt.
//   2. Idle ≥ 10 s so the VM stops with a checkpoint; then the file API (no VM running, so the branch) has the nonce.
//   3. bash run 2: a new boot_id (the VM rebooted from the branch head) and the file still holds the nonce.
//   3b. With the second VM held awake by a `sleep 60` run, a 20 MiB PUT through the file API takes the VM path
//      (VmFiles → putBlob → stdinBlob, L110): its version is the bytes' sha256, and the VM hashes the same bytes.
//   4. After the second VM stops, the 20 MiB file is on the branch; its usage is pulled and settled: the agent's usage has compute cost for the
//      host pool, and the account ledger's hourly usage entry gained compute seconds and cost to match.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const base = (process.env.CAMELRUN_URL ?? "").replace(/\/$/, "");
// The key is read inside this process (SMOKE_KEY_FILE) or taken from CAMELRUN_API_KEY; it is never printed.
const key = (process.env.SMOKE_KEY_FILE ? readFileSync(process.env.SMOKE_KEY_FILE, "utf8") : process.env.CAMELRUN_API_KEY ?? "").trim();
if (!base || !key) {
  console.error("CAMELRUN_URL and one of SMOKE_KEY_FILE or CAMELRUN_API_KEY are required");
  process.exit(2);
}
const IDLE_WAIT_MS = 25_000; // idle stop after ~10 s with no exec, plus the stop's checkpoint
const SETTLE_TIMEOUT_MS = 5 * 60_000; // usage is pulled every ~20 s and settled after
const RUN_TIMEOUT_MS = 5 * 60_000;
const BIG_BYTES = 20 * 2 ** 20; // over the old ~12–16 MiB inline-stdin cap (L110)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const log = (step: string, detail: unknown = "") => console.log(`[${new Date().toISOString()}] ${step}`, typeof detail === "string" ? detail : JSON.stringify(detail));

async function call(path: string, init: { method?: string; body?: unknown; raw?: Uint8Array; headers?: Record<string, string> } = {}) {
  const hasBody = init.body !== undefined || init.raw !== undefined;
  const response = await fetch(base + path, {
    method: init.method ?? (hasBody ? "POST" : "GET"),
    headers: { authorization: `Bearer ${key}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    ...(init.raw !== undefined ? { body: init.raw as unknown as BodyInit } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = bytes.length > 1 << 20 ? "" : new TextDecoder().decode(bytes);
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: response.status, text, json, bytes, headers: response.headers };
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5_000);
  }
}

async function send(agent: string, text: string): Promise<{ id: string; at: number }> {
  const at = Date.now();
  const accepted = await call(`/v1/agents/${agent}/prompt`, { body: { text, idempotencyKey: randomUUID() } });
  assert.equal(accepted.status, 202, `prompt: ${accepted.status} ${accepted.text}`);
  return { id: accepted.json.id, at };
}
async function prompt(agent: string, text: string) { return finished(agent, await send(agent, text)); }
async function finished(agent: string, { id, at: sent }: { id: string; at: number }) {
  const record = await until("the run to end", RUN_TIMEOUT_MS, async () => {
    const r = await call(`/v1/agents/${agent}/requests/${id}?wait=25`);
    assert.equal(r.status, 200, `request status: ${r.status} ${r.text}`);
    return r.json.state === "completed" && r.json;
  });
  const result = record.outcome?.result;
  assert.ok(result && !record.outcome.error && !result.code, `run failed: ${JSON.stringify(record.outcome)}`);
  // Client-side wall time from the prompt to the run's end (model turn + VM boot if cold + exec): the host does not log execs.
  log(`run ${id}: ${Date.now() - sent} ms from prompt to end`);
  const bash = (result.toolCalls ?? []).filter((c: any) => c.tool === "bash");
  assert.ok(bash.length >= 1 && bash.every((c: any) => c.ok), `expected ok bash calls: ${JSON.stringify(result.toolCalls)}`);
  return String(result.reply ?? "");
}

const bashOnly = (command: string) =>
  `Use the bash tool exactly once to run this exact command, unchanged, and then reply with its complete stdout and nothing else:\n\n${command}`;
const field = (reply: string, name: string) => new RegExp(`${name}=([A-Za-z0-9-]+)`).exec(reply)?.[1];

// The hour's usage ledger entries (prepaid accounts get one per hour, with compute in its metadata).
async function computeLedger() {
  const r = await call("/v1/billing/ledger?limit=50");
  assert.equal(r.status, 200, `ledger: ${r.status} ${r.text}`);
  let seconds = 0, micros = 0;
  for (const e of r.json.entries ?? []) {
    if (e.kind !== "usage") continue;
    seconds += Number(e.metadata?.computerSeconds ?? 0);
    micros += Number(e.metadata?.computer ?? 0);
  }
  return { seconds, micros };
}

// The agent's compute usage: rows whose model is a host pool's VM name (`test-2vcpu-4096mib`).
async function agentCompute(agent: string) {
  const r = await call(`/v1/agents/${agent}/usage?groupBy=model&days=1`);
  assert.equal(r.status, 200, `agent usage: ${r.status} ${r.text}`);
  const rows = (r.json.groups ?? []).filter((g: any) => /(?:^|:)(?:build|test)-\d+vcpu-\d+mib$/.test(String(g.model)));
  return { rows, cost: rows.reduce((sum: number, g: any) => sum + Number(g.cost ?? 0), 0) };
}

const nonce = `smoke-${randomUUID()}`;
const summary = await call("/v1/billing");
assert.equal(summary.status, 200, `billing: ${summary.status} ${summary.text}`);
// Only a prepaid account's ledger carries hourly usage entries; on another, the agent's usage is the charge to check.
const prepaid = summary.json.billing === "prepaid";
const ledgerBefore = await computeLedger();
log("billing", { mode: summary.json.billing, balance: summary.json.balance, ledgerBefore });

const created = await call("/v1/agents", {
  headers: { "Idempotency-Key": `compute-smoke-${Date.now()}` },
  body: { name: "compute-smoke", systemPrompt: "You run shell commands with the bash tool exactly as asked and report their output verbatim.",
    ...(process.env.SMOKE_MODEL ? { model: process.env.SMOKE_MODEL } : {}) },
});
assert.ok(created.status === 200 || created.status === 201, `create agent: ${created.status} ${created.text}`);
const agent: string = created.json.id;
log("agent", agent);

let failed: unknown;
try {
  const first = await prompt(agent, bashOnly(`echo hi; echo BOOT=$(cat /proc/sys/kernel/random/boot_id); echo ${nonce} > /workspace/smoke.txt; echo WROTE=$(cat /workspace/smoke.txt)`));
  log("run 1", first);
  assert.match(first, /\bhi\b/, "run 1 printed hi");
  const boot1 = field(first, "BOOT");
  assert.ok(boot1, "run 1 printed its boot_id");
  assert.equal(field(first, "WROTE"), nonce, "run 1 wrote the nonce");

  log(`idle ${IDLE_WAIT_MS / 1000} s for the VM to stop with a checkpoint`);
  await sleep(IDLE_WAIT_MS);
  const saved = await until("the file on the branch", 60_000, async () => {
    const r = await call(`/v1/agents/${agent}/files/smoke.txt`);
    return r.status === 200 && r.text.trim() === nonce && r;
  });
  log("file on branch", saved.text.trim());

  const second = await prompt(agent, bashOnly("echo BOOT=$(cat /proc/sys/kernel/random/boot_id); echo READ=$(cat /workspace/smoke.txt)"));
  log("run 2", second);
  const boot2 = field(second, "BOOT");
  assert.ok(boot2, "run 2 printed its boot_id");
  assert.notEqual(boot2, boot1, "run 2 ran on a new VM (the first one slept)");
  assert.equal(field(second, "READ"), nonce, "the file persisted on the branch across the reboot");

  // L110: a > 16 MiB write through the file API while the VM runs goes VmFiles → putBlob → stdinBlob → the guest.
  // A run holds the VM awake (sleep), the write lands, and the same command then hashes the file inside the VM.
  const big = randomBytes(BIG_BYTES), bigSha = sha256(big);
  const holding = await send(agent, bashOnly(`sleep 60; echo BIGSHA=$(sha256sum /workspace/big.bin | cut -d' ' -f1)`));
  const running = await until("the VM to be running (a file read answered by the VM)", 120_000, async () => {
    const r = await call(`/v1/agents/${agent}/files/smoke.txt`);
    // The VM path versions a file by its sha256; the branch path does not.
    return r.status === 200 && r.headers.get("x-file-version") === sha256(r.bytes) && r;
  });
  log("VM running; file reads come from it", running.headers.get("x-file-version"));
  const started = Date.now();
  const put = await call(`/v1/agents/${agent}/files/big.bin`, { method: "PUT", raw: big, headers: { "content-type": "application/octet-stream" } });
  assert.equal(put.status, 201, `big write: ${put.status} ${put.text}`);
  assert.equal(put.json?.size, BIG_BYTES, "big write size");
  assert.equal(put.json?.version, bigSha, "the big write took the VM path (its version is the bytes' sha256)");
  log(`big write: ${BIG_BYTES} bytes through VmFiles in ${Date.now() - started} ms`, put.json);
  const third = await finished(agent, holding);
  log("run 3", third);
  assert.equal(field(third, "BIGSHA"), bigSha, "the running VM holds the big file, byte for byte");

  log("waiting for the VM to stop, then for its usage to be pulled and settled");
  await sleep(IDLE_WAIT_MS);
  const onBranch = await until("the big file on the branch", 60_000, async () => {
    const r = await call(`/v1/agents/${agent}/files/big.bin`);
    return r.status === 200 && r.bytes.length === BIG_BYTES && sha256(r.bytes) === bigSha && r;
  });
  log("big file on the branch after the stop's checkpoint", { bytes: onBranch.bytes.length, version: onBranch.headers.get("x-file-version") });
  const usage = await until("compute usage on the agent", SETTLE_TIMEOUT_MS, async () => {
    const u = await agentCompute(agent);
    return u.cost > 0 && u;
  });
  log("agent compute usage", usage);
  let delta: { seconds: number; micros: number } | "not prepaid" = "not prepaid";
  if (prepaid) {
    const ledgerAfter = await until("compute on the ledger", SETTLE_TIMEOUT_MS, async () => {
      const l = await computeLedger();
      return l.micros - ledgerBefore.micros >= Math.round(usage.cost * 1e6) - 1 && l;
    });
    delta = { seconds: ledgerAfter.seconds - ledgerBefore.seconds, micros: ledgerAfter.micros - ledgerBefore.micros };
    log("ledger delta", delta);
    // Two VMs, each awake at least its ~10 s idle window (the second also ~60 s of sleep): at least 20 billed seconds.
    assert.ok(delta.seconds >= 20, `expected ≥ 20 compute seconds on the ledger, got ${delta.seconds}`);
    assert.ok(delta.micros > 0, "the ledger charged compute");
  } else log("ledger", "account is not prepaid: no hourly usage entries to check; the agent's usage is the charge");
  console.log("\nPASS compute smoke:", JSON.stringify({ agent, boot1, boot2, computeCostUsd: usage.cost, ledgerDelta: delta }));
} catch (error) {
  failed = error;
} finally {
  if (process.env.SMOKE_KEEP === "1") log("kept agent", agent);
  else {
    const removed = await call(`/v1/agents/${agent}`, { method: "DELETE" });
    log("deleted agent", removed.status);
  }
}
if (failed) {
  console.error("\nFAIL compute smoke:", failed);
  process.exit(1);
}
