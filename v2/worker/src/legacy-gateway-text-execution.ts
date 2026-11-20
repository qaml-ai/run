import { WorkerEntrypoint } from "cloudflare:workers";
import { executeStatelessRun } from "./stateless-run.ts";
import { getTenantStub } from "./tenant-do.ts";
import { extractApiError, type Env } from "./types.ts";

type TextRunRequest = {
  runId: string;
  fingerprint: string;
  input: string;
  instructions?: string;
  json: boolean;
  timeoutMs: number;
};
type Billing = { state: "settled" } | {
  state: "due"; startedAt: number; input: number; output: number; cacheRead: number; cacheWrite: number; serviceTier?: string;
};

const MODEL = "azure/gpt-6.2-sol";
const RETENTION_MS = 60_000;
const jsonHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json" };

function error(status: number, code: string, message: string) {
  return Response.json({ code, error: message }, { status, headers: jsonHeaders });
}

function receiptResponse(id: string, receipt: { started_at: number; expires_at: number; body: string | null }) {
  if (receipt.expires_at === 0) return error(404, "NOT_FOUND", "Unknown run");
  if (receipt.body !== null) {
    const { status, response } = JSON.parse(receipt.body) as { status: number; response: unknown };
    return Response.json(response, { status, headers: jsonHeaders });
  }
  return Response.json({ id, status: "running", text: "", error: null, usage: null, files: [], toolCalls: [], toolErrors: [],
    sourceErrors: [], createdAt: receipt.started_at, startedAt: receipt.started_at, endedAt: null, expiresAt: null },
    { status: 202, headers: jsonHeaders });
}

/** Only the legacy compatibility service can call this entrypoint after selecting a native run. */
export class LegacyGatewayTextExecution extends WorkerEntrypoint<Env> {
  private receipts(tenantId: string) {
    return getTenantStub(this.env, `camelrun:legacy-text-receipts:${tenantId}`);
  }

  async read(id: string): Promise<Response> {
    const tenantId = this.env.BUILDER_CUTOVER_CREDIT_TENANT_ID;
    if (!tenantId || !/^run_[a-f0-9]{40}$/.test(id)) return error(404, "NOT_FOUND", "Unknown run");
    const receipt = await this.receipts(tenantId).readLegacyTextReceipt(id);
    if (!receipt) return error(404, "NOT_FOUND", "Unknown run");
    return receiptResponse(id, receipt);
  }

  async billing(id: string, fingerprint: string): Promise<Billing | null> {
    const tenantId = this.env.BUILDER_CUTOVER_CREDIT_TENANT_ID;
    if (!tenantId || !/^run_[a-f0-9]{40}$/.test(id) || !/^[a-f0-9]{64}$/.test(fingerprint)) return null;
    const receipt = await this.receipts(tenantId).readLegacyTextBilling(id, fingerprint);
    return receipt === null ? null : JSON.parse(receipt) as Billing;
  }

  async ackBilling(id: string, fingerprint: string): Promise<void> {
    const tenantId = this.env.BUILDER_CUTOVER_CREDIT_TENANT_ID;
    if (!tenantId || !/^run_[a-f0-9]{40}$/.test(id) || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error("Invalid legacy text billing acknowledgement");
    }
    await this.receipts(tenantId).ackLegacyTextBilling(id, fingerprint);
  }

  async run(request: TextRunRequest): Promise<Response> {
    const tenantId = this.env.BUILDER_CUTOVER_CREDIT_TENANT_ID;
    if (!tenantId) return error(503, "RUNS_UNAVAILABLE", "Text runs are unavailable");
    const { runId, fingerprint, input, instructions, json, timeoutMs } = request;
    if (!/^run_[a-f0-9]{40}$/.test(runId) || !/^[a-f0-9]{64}$/.test(fingerprint) ||
        typeof input !== "string" || !input.trim() || typeof json !== "boolean" ||
        (instructions !== undefined && typeof instructions !== "string") ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      return error(400, "INVALID_REQUEST", "Invalid legacy text run");
    }
    const receipts = this.receipts(tenantId);
    const claim = await receipts.claimLegacyTextReceipt(runId, fingerprint);
    if (claim.fingerprint !== fingerprint) {
      return error(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was used for a different run");
    }
    if (!claim.inserted) return receiptResponse(runId, claim);
    const work = this.execute(tenantId, request, claim.started_at);
    this.ctx.waitUntil(work.then(() => undefined));
    return work;
  }

  private async execute(tenantId: string, request: TextRunRequest, startedAt: number): Promise<Response> {
    const { runId, input, instructions, fingerprint, json, timeoutMs } = request;
    const tenant = getTenantStub(this.env, tenantId);
    const deadline = AbortSignal.timeout(timeoutMs);
    let acquired = false;
    let response: unknown;
    let billing: Billing | null = null;
    let status = 200;
    let finishedAt: number;
    try {
      await tenant.checkRateLimit("runs");
      await tenant.acquireSlot(runId, runId, timeoutMs);
      acquired = true;
      deadline.throwIfAborted();
      let cacheRead = 0;
      const result = await executeStatelessRun(this.env, tenantId, {
        model: MODEL, input, instructions, maxSteps: 1,
        ...(json ? { outputSchema: { type: "object", additionalProperties: true } } : {}),
      }, deadline, true, tokens => { cacheRead += tokens; });
      finishedAt = Date.now();
      const inputTokens = result.usage.inputTokens - cacheRead;
      if (result.usage.inputTokens > 0 || result.usage.outputTokens > 0 || result.usage.costUsd > 0) {
        billing = { state: "due", startedAt, input: inputTokens, output: result.usage.outputTokens, cacheRead, cacheWrite: 0 };
      }
      response = {
        id: runId, status: result.status, text: result.text, error: result.error,
        ...(json ? { output: result.output } : {}),
        usage: {
          responses: 1, input: inputTokens, output: result.usage.outputTokens,
          cacheRead, cacheWrite: 0, costUsd: result.usage.costUsd,
        },
        servedModel: MODEL, toolCalls: [], toolErrors: [], sourceErrors: [], files: [],
        createdAt: startedAt, startedAt, endedAt: finishedAt, expiresAt: finishedAt + RETENTION_MS,
      };
    } catch (failure) {
      const known = extractApiError(failure);
      status = deadline.aborted ? 408 : (known?.status ?? 502);
      response = {
        code: deadline.aborted ? "deadline_exceeded" : (known?.code ?? "RUN_EXECUTION_FAILED"),
        error: known && status < 500 ? known.message : "The text run did not complete",
      };
      finishedAt = Date.now();
    } finally {
      if (acquired) await tenant.releaseSlot(runId).catch(() => {});
    }
    const body = JSON.stringify({ status, response });
    await this.receipts(tenantId).finishLegacyTextReceipt(runId, fingerprint, startedAt, body, finishedAt + RETENTION_MS,
      billing ? JSON.stringify(billing) : null);
    return Response.json(response, { status, headers: jsonHeaders });
  }
}
