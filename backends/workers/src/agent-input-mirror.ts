import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { HumanInputs, humanInputView } from "./human.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import { reqKey, type RequestRecord } from "./agent-types.ts";
import { stageInputMirror, type InputMirror } from "./input-mirror.ts";

/** Read the authority before staging an event or repairing the index. */
export async function readInputMirrors(runtime: AgentRuntime, ids?: string[]): Promise<InputMirror[]> {
  const conf = await runtime.config();
  const pi = await runtime.harness.pi();
  const doc = await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT);
  const rows: InputMirror[] = [];
  for (const [id, item] of Object.entries(doc?.requests ?? {})) {
    if (ids && !ids.includes(id)) continue;
    const requestId = item.requestId ?? await runtime.ctx.storage.get<string>(`input-owner:${id}`) ?? "";
    const record = await runtime.ctx.storage.get<RequestRecord>(reqKey(requestId));
    const ancestry = record ? await runtime.delegation.lineage(conf.id, record) : undefined;
    rows.push({ ...humanInputView(id, item, conf.id, requestId), tenant: conf.tenantId,
      subject: conf.config.subject ?? null,
      audience: item.inboxResponders ?? [...new Set([...item.responders?.audience ?? [], ...conf.config.humanInput?.approvers ?? []])],
      lineage: [...ancestry?.chain ?? [], conf.id], subagent: conf.config.type === "subagent" });
  }
  return rows;
}

export async function repairInputMirrors(runtime: AgentRuntime, ids?: string[]) {
  const rows = await readInputMirrors(runtime, ids);
  await runtime.ctx.storage.transaction(async tx => {
    for (const row of rows) await stageInputMirror(tx, row);
  });
  await runtime.webhooks.flush();
}
