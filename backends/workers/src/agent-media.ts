import { agentRepoId } from "./repos/identity.ts";
import { defineTool, type ToolRegistration, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { compile } from "@earendil-works/pi-schema";
import { GENERATE_IMAGE, generateImage, Imager, openaiImages, type Hold } from "./media/images.ts";
import type { AgentIdentity, ToolFiles, UsageRecord } from "./media/types.ts";
import type { MediaBindings } from "./media-api.ts";
import { mediaAzure } from "./media-azure.ts";
import { keyServices, type KeyServices, type KeyEnv } from "./security-services.ts";
import { database, transaction } from "./postgres.ts";
import { EndUserCredits } from "./end-user-credits.ts";
import { publishPending } from "./webhooks.ts";
import { admitAuxiliaryUsage, recordAuxiliaryUsage } from "./auxiliary-usage.ts";
import type { FileBindings, AgentMount as Mount, WrittenRepoFile } from "./files.ts";
import { HttpError } from "./errors.ts";
import { TOOL_FILE_LIMITS } from "../../../src/limits.ts";
import { scratchMount } from "./media/files-policy.ts";

export type AgentMediaScope = {
  tenant: string; agent: string; requestId?: string; spendLimit?: number; budget?: number;
  builtins?: string[]; keyScope?: string; identity?: AgentIdentity; actor?: string; bucket?: string; mounts: Mount[];
};
type CallScope = AgentMediaScope & { callId: string; startedAt: number };
type UsageScope = Pick<CallScope, "tenant" | "agent" | "requestId" | "callId" | "startedAt" | "identity" | "actor" | "keyScope" | "bucket">;
type MediaReceipt = { scope: UsageScope; usage: UsageRecord };
type Host = {
  storage?: DurableObjectStorage;
  onWrite?: (file: WrittenRepoFile, scope: CallScope) => Promise<void>;
  /** Host seams keep policy testable without a provider, database or R2. */
  files?: (scope: CallScope) => Promise<ToolFiles>;
  imager?: (scope: CallScope) => Promise<Imager>;
  admit?: (scope: CallScope) => Promise<void>;
  record?: (scope: CallScope, usage: UsageRecord) => Promise<void>;
  hold?: (scope: CallScope) => Hold | undefined;
};
type Env = FileBindings & MediaBindings & KeyEnv;

/** Mount operations use the platform's normal authorization and bounded streams. */
async function imageFiles(env: FileBindings, scope: CallScope, host: Host): Promise<ToolFiles> {
  const { handleAgentFileRequest } = await import("./files.ts");
  const { boundedBytes } = await import("./images.ts");
  const own = agentRepoId(scope.tenant, scope.agent);
  const workspace = scratchMount(scope.mounts.map(mount => ({ ...mount, workspace: 'repo'in mount ? mount.repo === own : mount.volumeId===`agent:${scope.agent}` })));
  if (!workspace) throw new Error("generate_image needs a workspace to save the image in, and this agent has none");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope.callId)));
  const directory = `${workspace.path}/tool-outputs/generate_image/${Array.from(hash.subarray(0, 12), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  const request = async (path: string, init?: RequestInit) => {
    if (!path.startsWith("/")) path = `${scope.mounts[0].path}/${path}`;
    const response = await handleAgentFileRequest(new Request("https://agent.invalid/files", {...init,headers:{...Object.fromEntries(new Headers(init?.headers)),"x-camel-call":scope.callId,...(scope.requestId?{"x-camel-run":scope.requestId}:{})}}), env, scope.tenant, scope.agent, path, scope.mounts, "api");
    if (!response.ok) {
      const error = await response.json() as { error?: string };
      throw new HttpError(response.status, error.error ?? "File operation failed");
    }
    return response;
  };
  return {
    async read(path, limit) { return boundedBytes((await request(path)).body, limit); },
    async save(name, bytes, contentType) {
      if (bytes.length > TOOL_FILE_LIMITS.callBytes) throw new HttpError(413, "The image exceeds the tool file byte limit");
      // A reservation survives a restart and is shared by parallel image calls.
      // Never refund an ambiguous write: the conservative count remains bounded.
      if (host.storage) await host.storage.transaction(async tx => {
        const key = `image-saved:${scope.requestId ?? "background"}`;
        const saved = await tx.get<Record<string, number>>(key) ?? {};
        if (saved[scope.callId] === undefined) {
          if (Object.values(saved).reduce((sum, size) => sum + size, 0) + bytes.length > TOOL_FILE_LIMITS.runBytes)
            throw new HttpError(413, "The run has saved as much image data as it may");
          saved[scope.callId] = bytes.length;
          await tx.put(key, saved);
        }
      });
      const path = `${directory}/${name}`;
      const response = await request(path, { method: "PUT", body: bytes as Uint8Array<ArrayBuffer>, headers: { "content-type": contentType } });
      const saved = await response.json() as { size: number; version: string; contentType?: string };
      const file = { path, version: saved.version, size: saved.size, contentType: saved.contentType ?? contentType };
      await host.onWrite?.(file, scope);
      return { type: "file", ...file };
    },
  };
}

async function recordImage(env: Env, services: KeyServices, scope: UsageScope, usage: UsageRecord) {
  const facts = { ...usage, bucket: scope.bucket, ...(scope.identity ? { identity: scope.identity } : {}), ...(scope.actor ? { actor: scope.actor } : {}), ...(scope.keyScope ? { keyScope: scope.keyScope } : {}), ...(scope.requestId ? { requestId: scope.requestId } : {}) };
  await transaction(env, async sql => {
    if (await recordAuxiliaryUsage(sql, { ...scope, kind: "image" }, { costUsd: usage.usage.cost.total, provider: usage.provider, model: usage.model }))
      await services.accounts.recordUsageIn(sql, scope.tenant, scope.agent, facts);
  });
  await services.accounts.usageCommitted(scope.tenant);
  await publishPending(env);
}

/** Known provider costs survive database outages without rerunning the image request. */
export async function flushAgentMediaUsage(env: Env, storage: DurableObjectStorage, record?: (receipt: MediaReceipt) => Promise<void>) {
  const receipts = await storage.list<MediaReceipt>({ prefix: "image-billing:" });
  if (!receipts.size) return;
  const services = record ? undefined : await keyServices(env);
  for (const [key, receipt] of receipts) {
    if (record) await record(receipt);
    else await recordImage(env, services!, receipt.scope, receipt.usage);
    await storage.delete(key);
  }
}

/** Source image policy with the same media key routing, billing and mounted files as the HTTP API. */
export async function agentMediaTools(env: Env, context: (api?: ToolExecutionApi) => Promise<AgentMediaScope>, host: Host = {}): Promise<ToolRegistration[]> {
  if (!(await context()).builtins?.includes("generate_image")) return [];
  const check = compile(GENERATE_IMAGE.parameters);
  return [defineTool({
    name: GENERATE_IMAGE.name, description: GENERATE_IMAGE.description, parameters: GENERATE_IMAGE.parameters,
    structuredOutputSchema: {}, replay: "unsafe",
    async execute(args, api, call) {
      if (!check.check(args)) throw new HttpError(400, "Invalid generate_image arguments");
      const scope = { ...await context(api), callId: `${api.conversationId}:${api.taskId}:${api.callId}`, startedAt: Date.now() };
      if (!scope.builtins?.includes("generate_image")) throw new HttpError(403, "generate_image is not enabled");
      const files = await (host.files?.(scope) ?? imageFiles(env, scope, host));
      const services = !host.imager || !host.admit || !host.record ? await keyServices(env) : undefined;
      if (host.admit) await host.admit(scope);
      else {
        await admitAuxiliaryUsage(env, scope);
        const refused = await services!.accounts.runLimit(scope.tenant);
        if (refused) throw typeof refused === "string" ? new HttpError(402, refused, "SPEND_LIMIT") : refused;
      }
      const imager = host.imager ? await host.imager(scope) : await (async () => {
        const { mediaKey, mediaOutbound } = await import("./media-api.ts");
        return new Imager({
          provider: openaiImages({ outbound: mediaOutbound(env), baseUrl: env.MEDIA_BASE_URL }),
          key: (tenant, keyScope, provider) => mediaKey(env, tenant, keyScope, provider, services, mediaAzure(env)?.imageDeployment),
          price: () => ({ ...services!.accounts.billing.pricing, ...(env.TEST_MODE === "1" ? JSON.parse(env.MEDIA_PRICING ?? "{}") : {}) }).image,
        });
      })();
      const usages: UsageRecord[] = [];
      const durable: Promise<void>[] = [];
      const { tenant, agent, requestId, callId, startedAt, identity, actor, keyScope, bucket } = scope;
      const receiptScope: UsageScope = { tenant, agent, requestId, callId, startedAt, identity, actor, keyScope, bucket };
      const billingKey = `image-billing:${scope.callId}`;
      const hold = host.hold ? host.hold(scope) : scope.identity?.subject
        ? (usd: number) => new EndUserCredits(database(env)).hold(scope.tenant, scope.identity!.subject!, scope.bucket ?? "default", usd, "image", { agent: scope.agent, ...(scope.requestId ? { requestId: scope.requestId } : {}) })
        : undefined;
      try {
        const result = await generateImage(imager, { tenant: scope.tenant, keyScope: scope.keyScope, budget: scope.budget, files: { read: (path, limit) => files.read(path, limit), save: async (...args) => { await Promise.all(durable); return files.save(...args); } }, hold, record: usage => {
          usages.push(usage);
          if (host.storage) {
            const persist = host.storage.put(billingKey, { scope: receiptScope, usage });
            void persist.catch(() => {});
            durable.push(persist);
          }
        } }, args as Record<string, unknown>, call.abortSignal ?? new AbortController().signal);
        // File references stay compact in Pi history. The provider image adapter
        // is the single seam for expanding image content, including generated files.
        return { output: result.content.map(part => ({ type: "text" as const, text: part.type === "text" ? part.text : JSON.stringify(part) })), structuredOutput: result.structuredContent };
      } finally {
        await Promise.all(durable);
        for (const usage of usages) {
          await (host.record ? host.record(scope, usage) : recordImage(env, services!, scope, usage));
          await host.storage?.delete(billingKey);
        }
      }
    },
  })];
}
