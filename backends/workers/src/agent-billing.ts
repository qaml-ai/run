import { tenantRunCaps } from "./tenant-run-caps.ts";
import { type AssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { reserveTurn, settleTurn } from "./control.ts";
import { applyModelReceipt, type ModelReceipt } from "./model-metering.ts";
import { keyServices } from "./security-services.ts";
import { runAdmission } from "./admission.ts";
import { billingRunStop } from "./billing-run-stop.ts";
import { usageCost } from "./webhook-policy.ts";
import { RunProjection } from "./run-projection.ts";
import { AgentRunLimits } from "./run-limits.ts";
import { EndUserCredits, creditError } from "./end-user-credits.ts";
import { auxiliaryRunCosts } from "./auxiliary-usage.ts";
import { readAgentSpendLimit, agentSpendRefusal } from "./agent-spend.ts";
import { flushAgentMediaUsage } from "./agent-media.ts";
import { flushAttachmentTranscriptions } from "./attachment-transcription.ts";
import { Config, RequestRecord, BillingReceipt, reqKey } from "./agent-types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import { dbPhase } from "./db-profile.ts";

export function createLimits(this: AgentRuntime): AgentRunLimits {
  return new AgentRunLimits(this.ctx.storage, async () => {
    const conf = await this.config();
    const run = await this.currentRun();
    return {
      config: conf.config,
      run,
      agentId: conf.id,
      spend: await this.agentSpend(conf),
      childCost: await this.delegation.cost(run.id),
      most: await tenantRunCaps(this.env, conf.tenantId),
    };
  }, async () => {
    const conf = await this.config(), run = await this.currentRun();
    const { accounts } = await keyServices(this.env);
    const refusal = await accounts.runLimit(conf.tenantId);
    if (typeof refusal === "string") return { error: refusal, code: "spend_limit", stopped: "spend_limit", limit: "tenant" };
    return billingRunStop(refusal ?? await this.endUserLimit(conf, "params" in run ? run.params?.bucket as string | undefined : undefined));
  });
}

export async function agentSpendImpl(this: AgentRuntime,
  conf: Config) {
    const spend = await readAgentSpendLimit(this.env, conf.tenantId, conf.id, { includeRevoked: this.shuttingDown });
    return spend
      ? {
          ...spend,
          spent: spend.spent + (await this.delegation.costSince(spend.setAt)),
        }
      : null;
  }

export async function admitRequestImpl(this: AgentRuntime,
  conf: Config,
  id: string,
  bucket?: string) {
    let acquired = false;
    try {
      const rate = await runAdmission(this.env, conf.tenantId);
      if (rate) this.runRates.set(id, rate);
      const refusal = agentSpendRefusal(conf.id, await this.agentSpend(conf));
      if (refusal)
        throw Object.assign(new Error(refusal.error), {
          status: 402,
          code: "SPEND_LIMIT",
        });
      const { accounts } = await keyServices(this.env);
      const limited = await accounts.runLimit(conf.tenantId);
      if (limited)
        throw typeof limited === "string"
          ? Object.assign(new Error(limited), { status: 402 })
          : limited;
      if (conf.config.subject && (conf.resolvedModel ?? this.models.resolve(conf.config.model)).api !== "openai-codex-responses") {
        const broke = await new EndUserCredits(accounts.db).refusal(conf.tenantId, conf.config.subject, bucket ?? conf.config.bucket ?? "default");
        if (broke) throw creditError(broke);
      }
      const { limit } = await accounts.billing.busyLimit(conf.tenantId);
      acquired = await this.env.TENANTS.getByName(conf.tenantId).acquire(
        `${conf.id}:${id}`,
        Math.min(
          limit,
          Number(this.env.TENANT_MAX_ACTIVE ?? Number.MAX_SAFE_INTEGER),
        ),
      );
      if (!acquired)
        throw Object.assign(new Error("Tenant concurrency limit"), {
          status: 429,
          code: "BUSY_AGENT_LIMIT",
        });
      await dbPhase("hold", () => reserveTurn(this.env, conf.tenantId, conf.id, id));
    } catch (error) {
      if (acquired)
        await this.env.TENANTS.getByName(conf.tenantId).release(
          `${conf.id}:${id}`,
        );
      await this.ctx.storage.delete(reqKey(id));
      this.runRates.delete(id);
      throw error;
    }
  }

export async function endUserLimitImpl(this: AgentRuntime,
  conf: Config,
  bucket?: string) {
    if (!conf.config.subject || conf.resolvedModel?.api === "openai-codex-responses") return;
    const { accounts } = await keyServices(this.env);
    const refusal = await new EndUserCredits(accounts.db).refusal(
      conf.tenantId, conf.config.subject,
      bucket ?? conf.config.bucket ?? await this.ctx.storage.get<string>("run-bucket") ?? "default",
    );
    return refusal ? creditError(refusal) : undefined;
  }

export function requestUsageImpl(this: AgentRuntime,
  record: RequestRecord,
  usage: Awaited<ReturnType<AgentRuntime["usageForRequest"]>>) {
    const total = this.usageView(usage);
    if (!record.usageBaseline) return total;
    return Object.fromEntries(Object.entries(total).map(([key, value]) => [key,
      Math.max(0, value - (record.usageBaseline?.[key] ?? 0)),
    ])) as typeof total;
  }

export function usageViewImpl(this: AgentRuntime,
  usage: Awaited<ReturnType<AgentRuntime["usageForRequest"]>>) {
    return {
                  responses: usage.responses,
                  input: usage.inputTokens,
                  output: usage.outputTokens,
                  cacheRead: usage.cacheRead,
                  cacheWrite: usage.cacheWrite,
                  costUsd: usage.costMicros / 1_000_000,
                  ...(usage.imageCostUsd > 0
                    ? { imageCostUsd: usage.imageCostUsd }
                    : {}),
                  ...(usage.transcriptionCostUsd > 0
                    ? { transcriptionCostUsd: usage.transcriptionCostUsd }
                    : {}),
                  ...(usage.decisionCostUsd > 0
                    ? { decisionCostUsd: usage.decisionCostUsd }
                    : {}),
                  ...(usage.webCostUsd > 0
                    ? { webCostUsd: usage.webCostUsd }
                    : {}),
                  ...(usage.subagentCostUsd > 0
                    ? { subagentCostUsd: usage.subagentCostUsd }
                    : {}),
                };
  }

export async function usageForRequestImpl(this: AgentRuntime,
  id: string) {
    const pi = await this.harness.pi(),
      root = await pi.root(BACKGROUND_CONTEXT);
    const conf = await this.config();
    const [auxiliary, subagentCostUsd] = await Promise.all([
      auxiliaryRunCosts(this.env, conf.tenantId, conf.id, id),
      this.piSubagents ? this.piSubagents.cost(id) : this.delegation.cost(id),
    ]);
    const children = this.piSubagents
      ? new Map(Object.values(await this.piSubagents.rows()).filter(row => row.runId === id).map(row => [row.toolCallId, row.agentId]))
      : new Map((await this.delegation.children()).filter(child => child.parentRequestId === id).map(child => [child.callId ?? child.toolCallId, child.id]));
    const projection = new RunProjection(id, children);
    let cursor,
      active: string | undefined,
      inputTokens = 0,
      outputTokens = 0,
      cacheRead = 0,
      cacheWrite = 0,
      responses = 0,
      cost = 0,
      last: AssistantMessage | undefined;
    do {
      const page = await root.entries(
        { order: "ascending" },
        256,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const entry of page.items) {
        projection.add(entry);
        if (entry.kind === "camel.prompt")
          active = (entry.data as { requestId: string }).requestId;
        if (active !== id) continue;
        for (const message of entry.model ?? [])
          if (message.role === "assistant") {
            last = message;
            if (message.stopReason === "error" && !(message.usage as { billingAttemptId?: string }).billingAttemptId) continue;
            responses++;
            inputTokens += message.usage.input;
            cacheRead += message.usage.cacheRead;
            cacheWrite += message.usage.cacheWrite;
            outputTokens += message.usage.output;
            cost += usageCost(message.usage).usd;
          }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    const discarded = await this.ctx.storage.get<AssistantMessage>(`discarded-output:${id}`);
    if (discarded) {
      responses++;
      inputTokens += discarded.usage.input;
      outputTokens += discarded.usage.output;
      cacheRead += discarded.usage.cacheRead;
      cacheWrite += discarded.usage.cacheWrite;
      cost += discarded.usage.cost.total;
    }
    return {
      last,
      ...projection.finish(),
      inputTokens,
      outputTokens,
      cacheRead,
      cacheWrite,
      responses,
      costUsd: cost,
      costMicros: Math.max(0, Math.round(cost * 1_000_000)),
      ...auxiliary,
      subagentCostUsd,
    };
  }

export async function flushBillingImpl(this: AgentRuntime,
  propagate = false) {
    try {
      await flushAttachmentTranscriptions(this.env, this.ctx.storage);
      await flushAgentMediaUsage(this.env, this.ctx.storage);
    } catch (error) {
      await this.arm(Date.now() + 1000);
      if (propagate) throw error;
    }
    for (const [key, receipt] of await this.ctx.storage.list<ModelReceipt>({
      prefix: "model-billing:",
    })) {
      try {
        await this.dbProfile.run("settle", () => applyModelReceipt(this.env, receipt));
        await this.ctx.storage.delete(key);
      } catch (error) {
        await this.arm(Date.now() + 1000);
        if (propagate) throw error;
      }
    }
    for (const [key, receipt] of await this.ctx.storage.list<BillingReceipt>({
      prefix: "billing:",
      limit: 100,
    })) {
      try {
        await this.dbProfile.run("settle", () => settleTurn(this.env, receipt));
        if (await this.testStorage.get("test:crash-settlement")) {
          await this.ctx.storage.transaction(async (tx) => {
            await this.testStorage.delete("test:crash-settlement", tx);
            await this.testStorage.put("test:crash-reached", true, tx);
            await this.testStorage.put("test:crash-owner", this.instanceId, tx);
          });
        }
        if (
          (await this.testStorage.get("test:crash-owner")) === this.instanceId
        ) {
          throw new Error(
            "Injected crash after PostgreSQL commit before DO acknowledgement",
          );
        }
        await this.env.TENANTS.getByName(receipt.tenantId).release(
          `${receipt.agentId}:${receipt.requestId}`,
        );
        await this.ctx.storage.delete(key);
      } catch (error) {
        await this.arm(Date.now() + 1000);
        if (propagate) throw error;
      }
    }
  }
