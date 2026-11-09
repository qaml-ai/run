import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { HumanInputs, humanInputView, bindHumanInput } from "./human.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import { reqKey, type RequestRecord } from "./agent-types.ts";
import { stageInputMirror, type InputMirror } from "./input-mirror.ts";

/** Read the authority before staging an event or repairing the index. */
async function readInputMirrorState(runtime: AgentRuntime, ids?: string[]) {
  const conf = await runtime.config();
  const pi = await runtime.harness.pi();
  const doc = await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT);
  const rows: InputMirror[] = [];
  for (const [id, saved] of Object.entries(doc?.requests ?? {})) {
    let item = saved;
    if (ids && !ids.includes(id)) continue;
    const requestId = item.requestId || await runtime.ctx.storage.get<string>(`input-owner:${id}`);
    // A newly committed Pi input may not have reached onHuman yet. Do not freeze
    // an empty owner, or report this retained input as missing to the sweep.
    if (!requestId) continue;
    const record = await runtime.ctx.storage.get<RequestRecord>(reqKey(requestId));
    // Startup may land even before onHuman bound the freshly committed request.
    if (!item.policyBound) {
      const actor = record?.params?.actor as string | undefined ?? (record?.params?.from as { id?: string } | undefined)?.id;
      item = await pi.commit(async tx => {
        const current = (await tx.doc(HumanInputs)).requests[id];
        Object.assign(current, bindHumanInput(current, requestId, actor, conf.config.humanInput, conf.expiresAt));
        return JSON.parse(JSON.stringify(current)) as typeof saved;
      }, BACKGROUND_CONTEXT);
    }
    const ancestry = record ? await runtime.delegation.lineage(conf.id, record) : undefined;
    rows.push({ ...humanInputView(id, item, conf.id, requestId), tenant: conf.tenantId,
      subject: conf.config.subject ?? null,
      audience: item.inboxResponders ?? [...new Set([...item.responders?.audience ?? [], ...conf.config.humanInput?.approvers ?? []])],
      lineage: [...ancestry?.chain ?? [], conf.id], subagent: conf.config.type === "subagent" });
  }
  return { rows, missing: ids?.filter(id => !Object.hasOwn(doc?.requests ?? {}, id)) ?? [] };
}

export async function readInputMirrors(runtime: AgentRuntime, ids?: string[]): Promise<InputMirror[]> {
  return (await readInputMirrorState(runtime, ids)).rows;
}

export async function restageInputMirrors(runtime: AgentRuntime, ids?: string[]) {
  const { rows, missing } = await readInputMirrorState(runtime, ids);
  await runtime.ctx.storage.transaction(async tx => {
    for (const row of rows) await stageInputMirror(tx, row);
  });
  return missing;
}

export async function repairInputMirrors(runtime: AgentRuntime, ids?: string[]) {
  const missing = await restageInputMirrors(runtime, ids);
  await runtime.webhooks.flush();
  return missing;
}
