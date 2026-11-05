import { defineDoc, defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { Context } from "@earendil-works/chord";
import { answerInput, questionsInput } from "./input-policy.ts";

export type HumanInput = {
  question: string; answer?: string; toolCallId?: string;
  kind?: "question" | "approval" | "form" | "url";
  detail?: Record<string, any>; createdAt?: number; expiresAt?: number;
  state?: "pending" | "answered" | "declined" | "cancelled" | "expired";
};

export const HumanInputs = defineDoc<{
  requests: Record<string, HumanInput>;
}>({
  kind: "camel.human-input",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
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
export async function waitForHuman(input: HumanInput, api: ToolExecutionApi, context: Context) {
    const key = String(api.taskId);
    await api.commit(async (tx) => {
      const doc = await tx.doc(HumanInputs, api.conversationId);
      if (!doc.requests[key]) {
        if (Object.keys(doc.requests).length >= 100)
          throw new Error("Human input retention limit reached");
        doc.requests[key] = { ...input, toolCallId: api.callId, createdAt: api.now(), expiresAt: api.now() + 7 * 86400_000, state: "pending" };
      }
    }, context);
    const watch = (await api.watchDoc(
      HumanInputs,
      api.conversationId,
      context,
    ))!;
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const read = (value: typeof watch.value) => {
          const answer = value.requests[key]?.answer;
          if (answer !== undefined) resolve(answer);
        };
        read(watch.value);
        watch.start(async (call) => {
          if (call.kind === "value") read(call.value);
        });
        void watch.closed.then(() =>
          reject(new Error("Human input wait interrupted")),
        );
      });
      return { output: [{ type: "text" as const, text: answer }] };
    } finally {
      await watch.stop();
    }
}

export function humanInputView(id: string, item: HumanInput, agent: string, requestId = "") {
  return {
    id, agent, requestId, toolCallId: item.toolCallId ?? id,
    kind: item.kind ?? "question", message: item.question,
    detail: item.detail ?? {}, state: item.state ?? (item.answer === undefined ? "pending" : "answered"),
    createdAt: item.createdAt ?? 0, expiresAt: item.expiresAt ?? 0,
    // Existing experimental clients use the unstructured question field.
    question: item.question,
  };
}

export function answerHuman(item: HumanInput, body: unknown) {
  const value = body as Record<string, unknown>;
  if (typeof value?.answer === "string") {
    if (value.answer.length > 4096) throw new Error("Answer exceeds 4096 characters");
    return { answer: value.answer, state: "answered" as const };
  }
  const checked = answerInput({ kind: item.kind ?? "question", detail: item.detail ?? {} }, body);
  return {
    answer: JSON.stringify(checked.action === "accept" ? checked.content ?? { approved: true } : { action: checked.action }),
    state: checked.action === "accept" ? "answered" as const : checked.action === "decline" ? "declined" as const : "cancelled" as const,
  };
}

export const askUser: ToolRegistration = {
  name: "ask_user",
  description: "Ask the user 1–4 questions with 2–4 options. The turn pauses until the user answers.",
  parameters: { type: "object", required: ["questions"], properties: { questions: { type: "array", minItems: 1, maxItems: 4, items: { type: "object" } } }, additionalProperties: false },
  replay: "safe",
  callers: ["model"],
  async execute(args, api, context) {
    const questions = questionsInput((args as { questions: unknown }).questions);
    return waitForHuman({ kind: "question", question: questions.length === 1 ? questions[0].question : `${questions.length} questions`, detail: { questions } }, api, context);
  },
};
