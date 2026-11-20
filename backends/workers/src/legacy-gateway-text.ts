import { createHash, timingSafeEqual } from "node:crypto";
import { canonical } from "../../../shared/durable-json.ts";
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
  const url = new URL(request.url);
  return request.method === "POST" && url.protocol === "https:" &&
    (url.host === "run.camelai.com" || url.host === "agents.camelai.dev") && url.pathname === "/v1/runs" &&
    !url.search && request.headers.get("content-type")?.toLowerCase().trim() === "application/json" &&
    request.headers.get("authorization")?.startsWith("Bearer ") &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.headers.get("idempotency-key") ?? "");
}

type Access = { tenant: string };

/** The configured digest selects one existing credential; its real principal must still match. */
export function legacyGatewayTextAccess(request: Request, config: string | undefined): Access | null {
  if (!config || !legacyGatewayTextRoute(request)) return null;
  const value = record(JSON.parse(config));
  if (!value || typeof value.tenant !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(value.tenant) ||
      typeof value.authorizationSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.authorizationSha256)) {
    throw new Error("Invalid legacy gateway text credential scope");
  }
  const actual = hash(request.headers.get("authorization")!);
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(value.authorizationSha256, "hex"))
    ? { tenant: value.tenant }
    : null;
}

export function legacyGatewayTextPrincipal(auth: AuthContext | null, access: Access) {
  return auth?.tenantId === access.tenant && auth.principal?.tenant === access.tenant &&
    (auth.principal.via === "token" || auth.principal.via === "operator");
}

export type LegacyGatewayTextRun = {
  legacyTenant: string;
  runId: string;
  idempotencyKey: string;
  fingerprint: string;
  input: string;
  instructions?: string;
  json: boolean;
  timeoutMs: number;
  subject: string;
  bucket: string;
};

export interface LegacyGatewayTextRuntime {
  /** Resolve pre-existing legacy ownership or claim and serve the original run receipt. */
  start(input: LegacyGatewayTextRun): Promise<
    { disposition: "legacy" } | { disposition: "handled"; response: Response }
  >;
}

function supportedOutput(value: unknown) {
  const output = record(value);
  const schema = record(output?.schema);
  return output && Object.keys(output).length === 1 && schema && Object.keys(schema).length === 2 &&
    schema.type === "object" && schema.additionalProperties === true;
}

/** Map the exact r745 SDK body before either runtime admits work. Everything else stays on the original route. */
export function legacyGatewayTextInput(body: unknown, tenant: string, idempotencyKey: string): LegacyGatewayTextRun | null {
  const value = record(body);
  if (!value || Object.keys(value).some(key => !gatewayFields.has(key))) return null;
  const { input, systemPrompt, model, runLimits, subject, bucket, output, wait, ...policy } = value;
  const limits = record(runLimits);
  if (typeof input !== "string" || !input.trim() || (systemPrompt !== undefined && typeof systemPrompt !== "string") ||
      model !== GATEWAY_MODEL || policy.codeMode !== false || policy.retentionSeconds !== 60 || policy.dataCollection !== "deny" ||
      wait !== true || !limits || Object.keys(limits).length !== 1 || typeof limits.maxSeconds !== "number" ||
      !Number.isSafeInteger(limits.maxSeconds) || limits.maxSeconds < 1 || limits.maxSeconds > 60 ||
      typeof bucket !== "string" || !/^bot:[a-f0-9]{16}$/.test(bucket) ||
      typeof subject !== "string" || !(subject === bucket || /^[0-9]{17,20}$/.test(subject)) ||
      (output !== undefined && !supportedOutput(output))) return null;

  const { wait: _wait, ...asked } = value;
  const oldSession = agentId(tenant, "run-" + hash(idempotencyKey).slice(0, 40));
  return {
    legacyTenant: tenant, runId: "run_" + oldSession.slice("client_".length), idempotencyKey,
    fingerprint: hash(canonical(asked)), input, ...(systemPrompt !== undefined ? { instructions: systemPrompt } : {}),
    json: output !== undefined, timeoutMs: limits.maxSeconds * 1000, subject, bucket,
  };
}

/** Inspect a bounded clone so an unselected request reaches the old node with its original body intact. */
export async function readLegacyGatewayText(request: Request, tenant: string): Promise<LegacyGatewayTextRun | null> {
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
    return legacyGatewayTextInput(JSON.parse(raw), tenant, request.headers.get("idempotency-key")!);
  } catch {
    // Transport and parser behavior remains owned by the original route until a valid shape is selected.
    return null;
  } finally {
    if (!ended) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
