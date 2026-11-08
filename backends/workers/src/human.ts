import { askUserDefinition } from "./inbox-definitions.ts";
import { defineDoc, defineTool, hook, ToolTask, type Extension, type Harness, type ToolExecutionApi, type ToolRegistration, type ToolTaskInput } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { Context } from "@earendil-works/chord";
import { answerInput, expiresAt, inboxDetail, expiryAnswer, INPUT_LIMITS, mayAnswer, questionsInput, resolution, settledAlready, type Answer, type HumanInputSettings, type InputRow, type Responder } from "./input-policy.ts";
import { HostExecutionRequest } from "./host-execution.ts";
import { senderInput } from "./sender.ts";
import { actorInput } from "./security-policy.ts";
import { HttpError } from "./errors.ts";
import { canonical } from "../../../shared/durable-json.ts";
import { scriptOf } from "./codemode-run.ts";
import { endScript, waitsOnPerson } from "../codemode/sandbox.ts";

export type HumanInput = {
  question: string; answer?: string; toolCallId?: string;
  priority?: "urgent" | "high" | "normal" | "low";
  kind?: "question" | "approval" | "form" | "url";
  detail?: Record<string, any>; createdAt?: number; expiresAt?: number;
  state?: "pending" | "answered" | "declined" | "cancelled" | "expired" | "superseded";
  answerDetail?: Omit<Answer, "content"> & { content?: any };
  responders?: { audience?: string[] };
  policyBound?: boolean;
  requestId?: string;
  conversationId?: number;
  /** A call from code's: its code mode call's task, which ends with the turn if this input closes without an answer. */
  parentTask?: string;
};

export const HumanInputs = defineDoc<{
  requests: Record<string, HumanInput>;
}>({
  kind: "camel.human-input-session",
  version: 1,
  scope: "session",
  initial: () => ({ requests: {} }),
  checkpointWhen: () => true,
});

// Re-entry watches the same durable request. The codemode journal owns delivery
// to the VM; no VM state or in-memory promise is treated as durable.
export const askHuman = defineTool({
  name: "ask_human",
  description: "Pause until the operator answers this question.",
  parameters: obj({ question: str({ maxLength: 4096 }) }),
  replay: "safe",
  async execute({ question }, api, context) {
    return waitForHuman({ question }, api, context);
  },
});

/** Pi journals and replays the wait, including a script parked on the tool. */
export async function waitForHuman(input: HumanInput, api: ToolExecutionApi, context: Context, requestKey?: string) {
    const key = requestKey === undefined ? String(api.taskId) : `${api.taskId}:${requestKey}`;
    const owner = await api.snapshot(HostExecutionRequest, api.conversationId, context);
    // A call from code: its script's VM may stop while the person decides, and that wait is not its time.
    const script = api.callId.includes("/") ? await scriptOf(api, context) : undefined;
    await api.commit(async (tx) => {
      const doc = await tx.doc(HumanInputs);
      if (!doc.requests[key]) {
        if (Object.keys(doc.requests).length >= 100)
          throw new Error("Human input retention limit reached");
        doc.requests[key] = { ...input, toolCallId: api.callId, conversationId: api.conversationId,
          ...(owner?.requestId ? { requestId: owner.requestId } : {}), ...(script ? { parentTask: script.parent } : {}),
          createdAt: api.now(), expiresAt: api.now() + INPUT_LIMITS.defaultExpiresSeconds * 1000, state: "pending" };
      }
    }, context);
    const release = script ? waitsOnPerson(script.startedAt, script.seed, script.call) : undefined;
    const watch = (await api.watchDoc(
      HumanInputs,
      context,
    ))!;
    try {
      const answer = await new Promise<HumanInput>((resolve, reject) => {
        const read = (value: typeof watch.value) => {
          const item = value.requests[key];
          if (item?.answer !== undefined) resolve(item);
        };
        read(watch.value);
        watch.start(async (call) => {
          if (call.kind === "value") read(call.value);
        });
        void watch.closed.then(() =>
          reject(new Error("Human input wait interrupted")),
        );
      });
      // Closed without an answer (aborted, expired, or a new message came instead): the script goes no further, and
      // this call is not made. A question's answer, a refusal or an approval is the call's, as the script goes on.
      const system = answer.answerDetail?.by.system;
      if (script && system && system !== "expired")
        endScript(script.startedAt, script.seed, `${api.callId.split("/").pop()} waited on a person, and the input was closed without an answer (${system}): the script ended there`);
      return humanInputResult(answer);
    } finally {
      release?.();
      await watch.stop();
    }
}

export function humanInputView(id: string, item: HumanInput, agent: string, requestId = "") {
  return {
    id, agent, requestId, toolCallId: item.toolCallId ?? id,
    kind: item.kind ?? "question", message: item.question,
    priority: item.detail?.priority ?? (item.kind === "approval" ? "high" : "normal"), blocking: true,
    attachments: item.detail?.attachments, links: item.detail?.links, recommendation: item.detail?.recommendation, applyRecommendationOnExpiry: item.detail?.applyRecommendationOnExpiry,
    detail: item.detail ?? {}, state: item.state ?? (item.answer === undefined ? "pending" : "answered"),
    responders: item.responders ?? {},
    createdAt: item.createdAt ?? 0, expiresAt: item.expiresAt ?? 0,
    // Existing experimental clients use the unstructured question field.
    question: item.question,
    ...(item.answerDetail ? { answer: item.answerDetail } : {}),
  };
}

/** Bind policy once, before publishing the input or accepting an answer. */
export function bindHumanInput(item: HumanInput, requestId: string, actor: string | undefined, settings: HumanInputSettings | undefined, agentExpiresAt: number | null): HumanInput {
  if (item.policyBound) return item;
  return { ...item, requestId, responders: actor ? { audience: [actor] } : {},
    expiresAt: expiresAt(settings, agentExpiresAt, item.createdAt), policyBound: true };
}

/** Question answers are model results; external tools retain their retry payload. */
export function humanInputResult(item: HumanInput) {
  if (item.answerDetail && (item.answerDetail.by.system || item.kind === "question" && item.detail?.questions)) {
    const view = humanInputView("", item, "", item.requestId);
    const input: InputRow = { ...view, tenant: "", kind: item.kind ?? "question", answer: item.answerDetail,
      stored: { message: item.question, detail: item.detail ?? {}, responders: item.responders ?? {}, tool: "ask_user", argumentsHash: "" } };
    const resolved = resolution([input], () => undefined);
    if ("result" in resolved) return { output: resolved.result.content, ...(resolved.result.isError ? { isError: true } : {}),
      ...(item.answerDetail.by.system ? { control: { terminate: item.answerDetail.by.system !== "expired" } } : {}) };
  }
  return { output: [{ type: "text" as const, text: item.answer! }] };
}

export function sameHumanAnswer(item: HumanInput, answer: { answerDetail: Answer }) {
  const recorded = item.answerDetail;
  return !!recorded && !recorded.by.system && recorded.action === answer.answerDetail.action && canonical(recorded.content ?? null) === canonical(answer.answerDetail.content ?? null);
}

export function answerHuman(item: HumanInput, body: unknown, via: Responder["via"] = "api", approvers: string[] = []) {
  const value = body as Record<string, unknown>;
  const by: Responder = { via, ...(value?.actor !== undefined ? { actor: actorInput(value.actor) } : {}), ...(value?.from !== undefined ? { from: senderInput(value.from) } : {}) };
  if (!mayAnswer({ responders: item.responders ?? {} }, by, approvers)) throw new HttpError(403, "This person may not answer this input");
  if (item.answer === undefined && item.expiresAt !== undefined && item.expiresAt <= Date.now()) throw new HttpError(409, settledAlready({ state: "expired", answer: { action: "cancel", by: { system: "expired" }, at: item.expiresAt } }));
  if (typeof value?.answer === "string") {
    if (value.answer.length > 4096) throw new HttpError(400, "Answer exceeds 4096 characters");
    return { answer: value.answer, state: "answered" as const, answerDetail: { action: "accept" as const, content: value.answer, by, at: Date.now() } };
  }
  const checked = answerInput({ kind: item.kind ?? "question", detail: item.detail ?? {} }, body);
  return {
    answer: JSON.stringify(checked.action === "accept" ? checked.content ?? { approved: true } : { action: checked.action }),
    state: checked.action === "accept" ? "answered" as const : checked.action === "decline" ? "declined" as const : "cancelled" as const,
    answerDetail: { ...checked, by, at: Date.now() },
  };
}

export function systemHumanAnswer(system: NonNullable<Responder["system"]>, now = Date.now()) {
  return { answer: '{"action":"cancel"}', state: system === "aborted" ? "cancelled" as const : system,
    answerDetail: { action: "cancel" as const, by: { system }, at: now } };
}

export function cancelledHumanInput(item: HumanInput, now = Date.now()): HumanInput {
  if (item.answer !== undefined) return item;
  return { ...item, ...systemHumanAnswer("aborted", now) };
}

/** A continued call starts again in the resume stream, with its original arguments. */
export async function resumedHumanTools(pi: Pick<Harness, 'getTask' | 'commit'>, keys: string[], context: Context) {
  const calls = new Map<string, { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }>();
  for (const key of keys) {
    let task = Number(key.split(':')[0]);
    if (!Number.isSafeInteger(task)) continue;
    for (let depth = 0; depth < 64; depth++) {
      const input = (await pi.getTask(task as never, context))?.input as ToolTaskInput | undefined;
      if (input?.kind === 'nested') { task = Number(input.parent); continue; }
      if (input?.kind !== 'model') break;
      const entry = await pi.commit(tx => tx.entry(input.assistant), context);
      for (const message of entry?.model ?? []) if (message.role === 'assistant')
        for (const call of message.content) if (call.type === 'toolCall' && call.id === input.callId)
          calls.set(call.id, { type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
      break;
    }
  }
  return [...calls.values()];
}

/** Pi keeps the tool result and its post-tools stop durable, even during abort. */
export function humanInputExtension(): Extension {
  return { name: "camel.human-input", hooks: [hook(ToolTask, {
    async afterTool(_call, result, api, context) {
      const prefix = String(api.taskId);
      const inputs = Object.entries((await api.snapshot(HumanInputs, context))?.requests ?? {})
        .filter(([key]) => key === prefix || key.startsWith(`${prefix}:`)).map(([, input]) => input);
      const closed = inputs.find(input => input.answerDetail?.by.system);
      if (!closed) {
        // A code mode call whose script waited on a person, and the input closed without an answer: the script ended
        // there (endScript), and the turn ends with it, as it does for a direct call.
        const ended = Object.values((await api.snapshot(HumanInputs, context))?.requests ?? {}).some(input => input.parentTask === prefix
          && input.answerDetail?.by.system && input.answerDetail.by.system !== "expired");
        return ended ? { ...result, isError: true, control: { ...result.control, terminate: true } } : undefined;
      }
      const terminate = inputs.every(input => input.answerDetail?.by.system && input.answerDetail.by.system !== "expired");
      return { ...result, ...humanInputResult(closed), control: { ...result.control, terminate } };
    },
  })] };
}

export const askUser: ToolRegistration = makeAskUser();
export function makeAskUser(attachments?: (items: any[]) => Promise<any[]>, builtins: readonly string[] = []): ToolRegistration { return {
  ...askUserDefinition(builtins),
  replay: "safe",
  structuredOutputSchema: {},
  // From code too: the turn pauses for the answer either way.
  callers: ["model", "tools"],
  async execute(args, api, context) {
    const detail = inboxDetail(args as Record<string, any>);
    if (detail.attachments?.length) { if (!attachments) throw new Error("Attachments are unavailable"); detail.attachments = await attachments(detail.attachments); }
    const questions = detail.questions;
    const result = await waitForHuman({ kind: "question", question: questions.length === 1 ? questions[0].question : `${questions.length} questions`, detail }, api, context);
    // Code gets the answers themselves (structuredOutput); the model, their text.
    const text = result.output.length === 1 && result.output[0].type === "text" ? result.output[0].text : undefined;
    let value: unknown;
    try { value = text === undefined ? undefined : JSON.parse(text); } catch { value = text; }
    return { ...result, ...(value !== undefined ? { structuredOutput: value as never } : {}) };
  },
}; }
