import { WorkerEntrypoint } from "cloudflare:workers";
import { EndUserCredits, utcDay } from "./end-user-credits.ts";
import { legacyGatewayTextPayer, type LegacyGatewayTextPayer, type LegacyGatewayTextRun, type LegacyGatewayTextRuntime } from "./legacy-gateway-text.ts";
import { platformUsage } from "./platform-pricing.ts";
import { database, type PostgresEnv } from "./postgres.ts";

type Receipt = { state: "settled" } | {
  state: "due";
  startedAt: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  serviceTier?: string;
};

export interface LegacyGatewayTextExecution {
  run(input: Pick<LegacyGatewayTextRun, "runId" | "fingerprint" | "input" | "instructions" | "json" | "timeoutMs">): Promise<Response>;
  read(id: string): Promise<Response>;
  billing(id: string, fingerprint: string): Promise<Receipt | null>;
  ackBilling(id: string, fingerprint: string): Promise<void>;
}

type Payer = LegacyGatewayTextPayer & { fingerprint: string };
type Env = PostgresEnv & {
  LEGACY_GATEWAY_TEXT_BILLING_TENANT: string;
  V2_LEGACY_GATEWAY_TEXT_EXECUTION: LegacyGatewayTextExecution;
};

const unavailable = () => Response.json({ error: "The run's accounting is unavailable; retry the same key", code: "RUNS_UNAVAILABLE" }, {
  status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "1" },
});

export function accountedLegacyGatewayText(execution: LegacyGatewayTextExecution, credits: Pick<EndUserCredits, "debit">, tenant: string): LegacyGatewayTextRuntime {
  const validPayer = (id: string, payer: Payer) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(tenant) && payer.legacyTenant === tenant &&
    /^run_[a-f0-9]{40}$/.test(id) && /^[a-f0-9]{64}$/.test(payer.fingerprint) && legacyGatewayTextPayer(payer.subject, payer.bucket);

  async function settle(id: string, payer: Payer, response: Response): Promise<Response> {
    // No usage can be final while the native response is still running. An expired public response may still owe a debit.
    if (response.status === 202) return response;
    try {
      const receipt = await execution.billing(id, payer.fingerprint);
      if (receipt?.state === "settled") return response;
      if (!receipt) {
        // A failure without provider evidence is not billable. A successful provider response must have a receipt.
        if (response.ok) throw new Error("Missing terminal text accounting receipt");
        return response;
      }
      const { startedAt, input, output, cacheRead, cacheWrite, serviceTier } = receipt;
      if (!Number.isSafeInteger(startedAt) || startedAt <= 0 || startedAt > 8_640_000_000_000_000 ||
          ![input, output, cacheRead, cacheWrite].every(value => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error("Invalid terminal text accounting receipt");
      }
      const priced = platformUsage({ input, output, cacheRead, cacheWrite, serviceTier, cost: { total: 0 } }, "azure", "gpt-6.2-sol");
      const usd = priced.usage.cost.total;
      if (!priced.known || !Number.isFinite(usd) || usd < 0) throw new Error("Original Azure Sol pricing is unavailable");
      // MONEY: use the existing end-user transaction, allowance/markup policy and durable one-debit receipt.
      await credits.debit(tenant, payer.subject, payer.bucket, usd, `legacy-gateway-text:${id}`, {
        call: "response", provider: "azure", model: "gpt-6.2-sol", agent: "client_" + id.slice("run_".length),
        requestId: id, usageDay: utcDay(startedAt),
      });
      await execution.ackBilling(id, payer.fingerprint);
      return response;
    } catch {
      void response.body?.cancel().catch(() => {});
      console.error(JSON.stringify({ type: "legacy_gateway_text_accounting_unavailable" }));
      return unavailable();
    }
  }

  return {
    async start(request) {
      if (!validPayer(request.runId, request)) return unavailable();
      const { runId, fingerprint, input, instructions, json, timeoutMs } = request;
      return settle(runId, request, await execution.run({ runId, fingerprint, input, instructions, json, timeoutMs }));
    },
    async read(id, payer) {
      if (!validPayer(id, payer)) return unavailable();
      return settle(id, payer, await execution.read(id));
    },
  };
}

/** Only the original-auth, sticky compatibility route can call the accounting service. */
export class LegacyGatewayTextAccounting extends WorkerEntrypoint<Env> implements LegacyGatewayTextRuntime {
  private runtime() {
    return accountedLegacyGatewayText(this.env.V2_LEGACY_GATEWAY_TEXT_EXECUTION,
      new EndUserCredits(database(this.env)), this.env.LEGACY_GATEWAY_TEXT_BILLING_TENANT);
  }

  async start(input: LegacyGatewayTextRun) {
    const operation = this.runtime().start(input);
    this.ctx.waitUntil(operation.then(() => {}, () => {}));
    return operation;
  }

  async read(id: string, payer: Payer) {
    return this.runtime().read(id, payer);
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
