import { createHash, timingSafeEqual } from "node:crypto";
import { canonical } from "../../../shared/durable-json.ts";
import { legacyGatewayTextAddress, legacyGatewayTextUncertain } from "../../../shared/legacy-gateway-text-address.ts";
import { agentId } from "../../../src/v1-agent-credentials.ts";
import type { AuthContext } from "./control.ts";

const MAX_RUN_BODY_BYTES = 7 * 1024 * 1024;
const GATEWAY_MODEL = "azure/gpt-6.2-sol";
const gatewayFields = new Set([
  "input", "systemPrompt", "output", "codeMode", "runLimits", "retentionSeconds", "dataCollection",
  "subject", "bucket", "model", "wait",
]);

type RecordBody = Record<string, unknown>;
function record(value: unknown): RecordBody | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordBody : null;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function legacyGatewayTextRoute(request: Request) {
  return legacyGatewayTextAddress(request)?.method === "POST" && !new URL(request.url).search &&
    request.headers.get("authorization")?.startsWith("Bearer ") &&
    request.headers.get("content-type")?.toLowerCase().trim() === "application/json";
}

type Access = { tenant: string };

function gatewayScope(config: string) {
  const value = record(JSON.parse(config));
  if (!value || typeof value.tenant !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(value.tenant) ||
      typeof value.authorizationSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.authorizationSha256) ||
      (value.mode !== undefined && value.mode !== "legacy-new" && value.mode !== "native-new")) {
    throw new Error("Invalid legacy gateway text credential scope");
  }
  return { tenant: value.tenant, authorizationSha256: value.authorizationSha256, nativeNew: value.mode === "native-new" };
}

function gatewayCredentialMatches(request: Request, fingerprint: string) {
  const actual = hash(request.headers.get("authorization")!);
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(fingerprint, "hex"));
}

export function legacyGatewayTextPrincipal(auth: AuthContext | null, access: Access) {
  return auth?.tenantId === access.tenant && auth.principal?.tenant === access.tenant &&
    (auth.principal.via === "token" || auth.principal.via === "operator");
}

export type LegacyGatewayTextPayer = { legacyTenant: string; subject: string; bucket: string };

export type LegacyGatewayTextRun = LegacyGatewayTextPayer & {
  runId: string;
  idempotencyKey: string;
  fingerprint: string;
  input: string;
  instructions?: string;
  json: boolean;
  timeoutMs: number;
};

/** The accounting path behind this binding must preserve the original payer. Its private transport never falls back. */
export interface LegacyGatewayTextRuntime {
  start(input: LegacyGatewayTextRun): Promise<Response>;
  read(id: string, payer: LegacyGatewayTextPayer & { fingerprint: string }): Promise<Response>;
}

export type LegacyGatewayTextOwner = { owner: "legacy" } | {
  owner: "native"; fingerprint: string; subject: string; bucket: string;
};
export interface LegacyGatewayTextRouteStore {
  lookup(id: string): Promise<LegacyGatewayTextOwner | null>;
  pin(id: string, owner: LegacyGatewayTextOwner): Promise<LegacyGatewayTextOwner>;
}

const legacySessionId = (tenant: string, key: string) => agentId(tenant, "run-" + hash(key).slice(0, 40));
const runIdOf = (session: string) => "run_" + session.slice("client_".length);

export function legacyGatewayTextPayer(subject: unknown, bucket: unknown): boolean {
  return typeof bucket === "string" && /^bot:[a-f0-9]{16}$/.test(bucket) &&
    typeof subject === "string" && (subject === bucket || /^[0-9]{17,20}$/.test(subject));
}

function supportedOutput(value: unknown) {
  const output = record(value);
  const schema = record(output?.schema);
  return output && Object.keys(output).length === 1 && schema && Object.keys(schema).length === 2 &&
    schema.type === "object" && schema.additionalProperties === true;
}

/** Map the exact r745 SDK body before either runtime admits work. Everything else stays on the original route. */
export function legacyGatewayTextInput(body: unknown, tenant: string, idempotencyKey: string, replay = false): LegacyGatewayTextRun | null {
  const value = record(body);
  if (!value || Object.keys(value).some(key => !gatewayFields.has(key))) return null;
  const { input, systemPrompt, model, runLimits, subject, bucket, output, wait, ...policy } = value;
  const limits = record(runLimits);
  const validWait = replay ? (wait === undefined || typeof wait === "boolean" || typeof wait === "number" && wait >= 0) : wait === true;
  if (typeof input !== "string" || !input.trim() || (systemPrompt !== undefined && typeof systemPrompt !== "string") ||
      model !== GATEWAY_MODEL || policy.codeMode !== false || policy.retentionSeconds !== 60 || policy.dataCollection !== "deny" ||
      !validWait || !limits || Object.keys(limits).length !== 1 || typeof limits.maxSeconds !== "number" ||
      !Number.isSafeInteger(limits.maxSeconds) || limits.maxSeconds < 1 || limits.maxSeconds > 60 ||
      typeof bucket !== "string" || typeof subject !== "string" || !legacyGatewayTextPayer(subject, bucket) ||
      (output !== undefined && !supportedOutput(output))) return null;

  const { wait: _wait, ...asked } = value;
  return {
    legacyTenant: tenant, runId: runIdOf(legacySessionId(tenant, idempotencyKey)), idempotencyKey,
    fingerprint: hash(canonical(asked)), input, ...(systemPrompt !== undefined ? { instructions: systemPrompt } : {}),
    json: output !== undefined, timeoutMs: limits.maxSeconds * 1000, subject, bucket,
  };
}

const runError = (status: number, code: string, error: string, headers: Record<string, string> = {}) =>
  Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store", ...headers } });

function pendingPoll(response: Response) {
  return new Response(response.body, { status: 200, headers: response.headers });
}

async function legacyGatewayTextRead(runtime: LegacyGatewayTextRuntime, runId: string, payer: LegacyGatewayTextPayer & { fingerprint: string }, wait: string | null, signal: AbortSignal) {
  const seconds = wait === null ? 0 : Number(wait);
  if (!Number.isFinite(seconds) || seconds < 0) return runError(400, "INVALID_REQUEST", "wait is true, or a number of seconds");
  const deadline = Date.now() + Math.min(25, seconds) * 1000;
  for (;;) {
    signal.throwIfAborted();
    const response = await runtime.read(runId, payer);
    if (response.status !== 202) return response;
    const left = deadline - Date.now();
    if (left <= 0) return pendingPoll(response);
    void response.body?.cancel().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.min(left, 1000));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); }
    });
  }
}

/** Decide ownership before checking whether the posted shape qualifies for new native work. */
export async function routeLegacyGatewayText(request: Request, options: {
  config: string;
  routes(tenant: string): LegacyGatewayTextRouteStore;
  auth(): Promise<AuthContext | null>;
  legacyExists(session: string): Promise<boolean>;
  admitHttp(): Promise<unknown>;
  runtime?: LegacyGatewayTextRuntime;
}): Promise<Response | null> {
  const address = legacyGatewayTextAddress(request);
  if (!address) return null;
  const scope = gatewayScope(options.config);
  const auth = await options.auth();
  if (auth?.tenantId !== scope.tenant || auth.principal?.tenant !== scope.tenant) return null;
  const routes = options.routes(scope.tenant);

  if (address.method === "GET") {
    const pin = await routes.lookup(address.runId);
    if (pin?.owner !== "native") return null;
    if (!options.runtime) return legacyGatewayTextUncertain();
    await options.admitHttp();
    const { fingerprint, subject, bucket } = pin;
    return legacyGatewayTextRead(options.runtime, address.runId, { legacyTenant: scope.tenant, fingerprint, subject, bucket }, address.wait, request.signal);
  }

  const session = legacySessionId(scope.tenant, address.key);
  const runId = runIdOf(session);
  let pin = await routes.lookup(runId);
  if (pin?.owner === "legacy") return null;
  const selectsNew = scope.nativeNew && !!options.runtime && legacyGatewayTextPrincipal(auth, scope) && legacyGatewayTextRoute(request) &&
    gatewayCredentialMatches(request, scope.authorizationSha256);
  let input = selectsNew ? await readLegacyGatewayText(request, scope.tenant) : null;
  if (!pin) {
    const fresh = input && !await options.legacyExists(session) ? input : null;
    pin = await routes.pin(runId, fresh ? {
      owner: "native", fingerprint: fresh.fingerprint, subject: fresh.subject, bucket: fresh.bucket,
    } : { owner: "legacy" });
  }
  if (pin.owner === "legacy") return null;
  input ??= await readLegacyGatewayText(request, scope.tenant, true);
  if (!input || pin.fingerprint !== input.fingerprint || pin.subject !== input.subject || pin.bucket !== input.bucket) {
    return runError(409, "IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for another run; use another key");
  }
  if (!options.runtime) return legacyGatewayTextUncertain();
  await options.admitHttp();
  return options.runtime.start(input);
}

/** Inspect a bounded clone so an unselected request reaches the old node with its original body intact. */
export async function readLegacyGatewayText(request: Request, tenant: string, replay = false): Promise<LegacyGatewayTextRun | null> {
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let length = 0;
  let raw = "";
  let ended = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        raw += text.decode();
        break;
      }
      length += value.byteLength;
      if (length > MAX_RUN_BODY_BYTES) return null;
      raw += text.decode(value, { stream: true });
    }
    return legacyGatewayTextInput(JSON.parse(raw), tenant, request.headers.get("idempotency-key")!, replay);
  } catch {
    // Transport and parser behavior remains owned by the original route until a valid shape is selected.
    return null;
  } finally {
    if (!ended) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
