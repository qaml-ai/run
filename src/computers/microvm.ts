import { SHARED_COMPUTER_STOPPED } from "../core/computer-share.ts";
import { HttpError } from "../core/http-error.ts";
import { reserveComputer, suspendComputer, beginComputerUse, endComputerUse } from "../core/computer-limit.ts";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { transaction, type Db } from "../db.ts";
import type { Outbound } from "../outbound.ts";
import { BoatRefused, type Machine, type ManagedMachines } from "./managed.ts";

export const MICROVM_MAX_SECONDS = 28800;
// ARM baseline: 1 vCPU, 2 GiB. Keep the image's resources in sync with these rates.
export const MICROVM_HOUR = (0.0000276944 + 2 * 0.0000036667) * 3600;
export type MicrovmSettings = { image: string; version?: string; region: string; idleSeconds: number };
export type MicrovmApi = (operation: string, input: Record<string, any>) => Promise<any>;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const paths: Record<string, [string, string]> = {
  RunMicrovm: ["POST", ""], ListMicrovms: ["GET", ""], GetMicrovm: ["GET", "/{id}"],
  TerminateMicrovm: ["DELETE", "/{id}"], SuspendMicrovm: ["POST", "/{id}/suspend"],
  ResumeMicrovm: ["POST", "/{id}/resume"], CreateMicrovmAuthToken: ["POST", "/{id}/auth-token"],
};
// The local AWS service model (2025-09-09) uses Lambda's endpoint and signing name.
export function microvmApi(region: string, outbound: Outbound): MicrovmApi {
  class Sha256 {
    private hash;
    constructor(secret?: any) { this.hash = secret ? createHmac("sha256", typeof secret === "string" ? secret : Buffer.from(secret)) : createHash("sha256"); }
    update(data: any) { this.hash.update(typeof data === "string" ? data : Buffer.from(data)); }
    async digest() { return this.hash.digest(); }
  }
  // SigV4 also needs HMAC for its signing key.
  const signer = new SignatureV4({ credentials: defaultProvider(), region, service: "lambda", sha256: Sha256 });
  return async (operation, input) => {
    const [method, suffix] = paths[operation] ?? [];
    if (!method) throw new Error("Unknown MicroVM operation");
    const { microvmIdentifier, ...payload } = input;
    const path = `/2025-09-09/microvms${suffix.replace("{id}", encodeURIComponent(microvmIdentifier ?? ""))}`;
    const hostname = `lambda.${region}.amazonaws.com`;
    const query = method === "GET" ? Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)])) : {};
    for (let attempt = 0; ; attempt++) {
      const request = await signer.sign({ method, protocol: "https:", hostname, path, query,
        headers: { host: hostname, "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(payload) } : {}) });
      const response = await outbound.fetch(`https://${hostname}${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}`, {
        method, headers: { "content-type": "application/json" }, secrets: request.headers,
        ...(request.body ? { body: request.body } : {}), timeoutMs: 30000, maxBytes: 4 * 1024 * 1024, maxRedirects: 0,
      });
      const value = await response.json().catch(() => ({})) as any;
      if (response.ok) return value;
      const code = String(response.headers.get("x-amzn-errortype")?.split(":")[0] ?? value.__type ?? value.code ?? value.Type ?? "").split("#").at(-1);
      if ((response.status === 429 || code === "ThrottlingException") && attempt < 4) { await sleep(250 * 2 ** attempt + Math.random() * 250); continue; }
      if (response.status === 404) throw Object.assign(new Error("MicroVM not found"), { status: 404 });
      if (response.status === 429 || code === "ThrottlingException") throw new BoatRefused({ code: "rate_limited" });
      if (code === "ServiceQuotaExceededException") throw new BoatRefused({ code: "limit_reached" });
      if (code === "InsufficientCapacityException") throw new BoatRefused({ code: "out_of_capacity" });
      if (response.status === 401 || response.status === 403) throw new BoatRefused({ code: `http_${response.status}` });
      throw new Error(`MicroVM API HTTP ${response.status}`);
    }
  };
}

export type Observation = {
  state: string; at: number; startedAt: number; seconds: number; suspendedSeconds: number; suspends: number; resumes: number;
};
const timestamp = (value: string | number) => typeof value === "number" ? value * 1000 : Date.parse(value);
const paused = (state: string) => state === "SUSPENDING" || state === "SUSPENDED";
/** Integrate observed state intervals. AWS does not expose a cost or transition history API. */
export function observe(previous: Observation | undefined, vm: any, now: number): Observation {
  const startedAt = timestamp(vm.startedAt);
  if (!Number.isFinite(startedAt)) throw new Error("Missing MicroVM start time");
  const at = Math.max(previous?.at ?? startedAt, Math.min(now, vm.terminatedAt ? timestamp(vm.terminatedAt) : now));
  const old = previous ?? { state: "RUNNING", at: startedAt, startedAt, seconds: 0, suspendedSeconds: 0, suspends: 0, resumes: 0 };
  if (now < old.at) return old;
  const elapsed = Math.max(0, (at - old.at) / 1000);
  return { ...old, at, state: vm.state,
    seconds: old.seconds + (!paused(old.state) && old.state !== "TERMINATED" ? elapsed : 0),
    suspendedSeconds: old.suspendedSeconds + (paused(old.state) ? elapsed : 0),
    suspends: old.suspends + (!paused(old.state) && paused(vm.state) ? 1 : 0),
    resumes: old.resumes + (paused(old.state) && !paused(vm.state) && vm.state !== "TERMINATED" && vm.state !== "TERMINATING" ? 1 : 0) };
}
export const microvmCost = (o: Observation) => o.seconds * MICROVM_HOUR / 3600 + 2 * (o.suspends * 0.0038 + o.resumes * 0.00155 + o.suspendedSeconds * 0.08 / (30 * 86400));

export function microvmMachines(options: { db: Db; outbound: Outbound; settings: MicrovmSettings; runtime: string; api?: MicrovmApi; now?: () => number; sleep?: (ms: number) => Promise<void>; tenantComputerLimit?: (tenant: string) => number | undefined }): ManagedMachines {
  const { db, outbound, settings } = options, now = options.now ?? Date.now, wait = options.sleep ?? sleep;
  const api = options.api ?? microvmApi(settings.region, outbound);
  const tokens = new Map<string, { until: number; headers: Record<string, string> }>();
  const tokenPending = new Map<string, Promise<Record<string, string>>>();
  const get = async (id: string) => api("GetMicrovm", { microvmIdentifier: id });
  const record = async (computer: string, vm: any, at = now()) => transaction(db, async sql => {
    const row = (await sql.query("select * from managed_computers where id=$1 for update", [computer])).rows[0];
    if (!row) throw new Error("Unknown MicroVM owner");
    const state = row.microvm ?? {}, observation = observe(state.observation, vm, at);
    await sql.query("update managed_computers set microvm=$2,machine=$3 where id=$1", [computer, JSON.stringify({ ...state, observation, endpoint: vm.endpoint }), vm.microvmId]);
    if (paused(vm.state) || vm.state === "TERMINATED") await suspendComputer(sql, row.tenant, row.connection, at);
    return { row, observation };
  });
  const token = async (id: string) => {
    const existing = tokens.get(id);
    if (existing && existing.until > now() + 60000) return existing.headers;
    let pending = tokenPending.get(id);
    if (!pending) {
      pending = (async () => {
        const at = now(), value = await api("CreateMicrovmAuthToken", { microvmIdentifier: id, expirationInMinutes: 60, allowedPorts: [{ port: 8080 }] });
        if (!value.authToken || typeof value.authToken !== "object" || !Object.keys(value.authToken).length || Object.values(value.authToken).some(v => typeof v !== "string")) throw new Error("Invalid MicroVM token");
        tokens.set(id, { until: at + 3600000, headers: value.authToken });
        return value.authToken as Record<string, string>;
      })();
      tokenPending.set(id, pending);
    }
    try { return await pending; } finally { tokenPending.delete(id); }
  };
  const proxy = async (id: string, endpoint: string, path: string, body?: unknown) => {
    const url = new URL(endpoint.startsWith("https://") ? endpoint : `https://${endpoint}`);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid MicroVM endpoint");
    for (let attempt = 0; ; attempt++) {
      const response = await outbound.fetch(`${url.origin}${path}`, { method: body === undefined ? "GET" : "POST",
        secrets: await token(id), headers: { "X-aws-proxy-port": "8080", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), timeoutMs: 35000, maxBytes: 1024 * 1024, maxRedirects: 0 });
      if (response.status >= 500 && attempt === 0) { await response.body?.cancel(); await wait(1000); continue; }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`MicroVM agent HTTP ${response.status}`); }
      return { status: response.status, value: await response.json() as any };
    }
  };
  return {
    async create(computer, tenant, ttlSeconds) {
      // Store the exact request before sending it: retries after a restart use the same image/version and TTL.
      const request = { imageIdentifier: settings.image, ...(settings.version ? { imageVersion: settings.version } : {}),
        idlePolicy: { maxIdleDurationSeconds: settings.idleSeconds, suspendedDurationSeconds: MICROVM_MAX_SECONDS, autoResumeEnabled: true },
        maximumDurationInSeconds: Math.min(ttlSeconds, MICROVM_MAX_SECONDS), clientToken: computer,
        logging: { disabled: {} },
        runHookPayload: JSON.stringify({ runtime: options.runtime, computer, tenant }) };
      await db.query("update managed_computers set microvm=$2 where id=$1 and microvm is null", [computer, JSON.stringify({ request })]);
      const row = (await db.query("select * from managed_computers where id=$1", [computer])).rows[0];
      if (!row?.microvm?.request) throw new Error("Missing MicroVM launch request");
      const vm = row.machine ? await get(row.machine) : await api("RunMicrovm", row.microvm.request);
      if (typeof vm.microvmId !== "string" || !vm.endpoint) throw new Error("Incomplete MicroVM launch response");
      await record(computer, vm);
      for (let attempt = 0; attempt < 45; attempt++) {
        try {
          await proxy(vm.microvmId, vm.endpoint, "/health");
          await db.query("update managed_computers set microvm=jsonb_set(microvm,'{ready}','true') where id=$1", [computer]);
          return { id: vm.microvmId };
        }
        catch { if (attempt === 44) throw new Error("MicroVM startup timed out"); await wait(1000); }
      }
      throw new Error("MicroVM startup timed out");
    },
    // AWS's maximum duration cannot be extended. ManagedComputers keeps this fixed deadline.
    async extend() { throw new Error("MicroVM sessions have a fixed expiry"); },
    async remove(id) {
      try {
        await api("TerminateMicrovm", { microvmIdentifier: id });
        for (let attempt = 0; attempt < 30; attempt++) {
          const at = now(), vm = await get(id);
          const row = (await db.query("select id from managed_computers where machine=$1 and provider='lambda'", [id])).rows[0];
          if (row) await record(row.id, vm, at);
          if (vm.state === "TERMINATED") { tokens.delete(id); return; }
          await wait(1000);
        }
        throw new Error("MicroVM termination not confirmed");
      } catch (error: any) { if (error?.status !== 404) throw error; tokens.delete(id); }
    },
    async list(computer) {
      // Ownership comes from durable rows, not account-wide enumeration or mutable VM tags.
      const rows = (await db.query("select * from managed_computers where provider='lambda' and ended_at is null and ($1::text is null or id=$1)", [computer ?? null])).rows;
      const found: Machine[] = [];
      for (const row of rows) {
        if (!row.machine) continue; // An interrupted create is recovered with its persisted clientToken.
        const at = now();
        let vm;
        try { vm = await get(row.machine); } catch (error: any) { if (error?.status === 404) continue; throw error; }
        const { observation } = await record(row.id, vm, at);
        found.push({ id: row.machine, computer: row.id, tenant: row.tenant, createdAt: Number(row.created_at),
          since: String(observation.startedAt), seconds: Math.floor(observation.seconds), dollars: microvmCost(observation), ended: vm.state === "TERMINATED" });
      }
      return found;
    },
    async run(id, command, timeoutSeconds, requestKey = randomUUID(), shared = false) {
      const vm = await get(id), at = now();
      const row = (await db.query("select id from managed_computers where machine=$1 and provider='lambda'", [id])).rows[0];
      if (!row) throw new Error("Unknown MicroVM owner");
      const current = await record(row.id, vm, at);
      if (shared && (paused(vm.state) || vm.state === "TERMINATED" || vm.state === "TERMINATING"))
        throw new HttpError(409, SHARED_COMPUTER_STOPPED, "COMPUTER_STOPPED");
      await transaction(db, async sql => {
        await reserveComputer(sql, current.row.tenant, current.row.agent, current.row.connection,
          Number(current.row.deadline), now(), options.tenantComputerLimit?.(current.row.tenant));
        await beginComputerUse(sql, current.row.tenant, current.row.connection, now() + (timeoutSeconds + 60) * 1000);
      });
      try {
        // Hash arbitrary operation keys into the agent's path-safe key space.
        const key = createHash("sha256").update(requestKey).digest("hex");
        const until = now() + (timeoutSeconds + 60) * 1000;
        let response;
        // Retrying the POST after a dropped response is safe: the agent stores the key before starting.
        for (let attempt = 0; ; attempt++) {
          try { response = await proxy(id, vm.endpoint, "/exec", { command, timeoutSeconds, requestKey: key }); break; }
          catch (error) { if (attempt === 1) throw error; await wait(1000); }
        }
        await record(row.id, { ...vm, state: "RUNNING" });
        while (response.status === 202 && now() < until) {
          try { response = await proxy(id, vm.endpoint, `/exec/${key}?wait=25`); }
          catch { response = await proxy(id, vm.endpoint, `/exec/${key}?wait=25`); }
        }
        const result = response.value;
        if (response.status !== 200 || !Number.isInteger(result.exitCode) || typeof result.stdout !== "string" || typeof result.stderr !== "string" || typeof result.truncated !== "boolean") throw new Error("Incomplete MicroVM command result");
        return { exitCode: result.exitCode, stdout: result.stdout.slice(0, 65536), stderr: result.stderr.slice(0, 65536), truncated: result.truncated || result.stdout.length > 65536 || result.stderr.length > 65536 };
      } finally { await endComputerUse(db, current.row.tenant, current.row.connection); }
    },
  };
}
