import { defineDoc, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

export const HumanInputs = defineDoc<{ requests: Record<string, { question: string; answer?: string }> }>({
  kind: "camel.human-input", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ requests: {} }), checkpointWhen: () => true,
});

// Re-entry watches the same durable request. The codemode journal owns delivery
// to the VM; no VM state or in-memory promise is treated as durable.
export const askHuman = defineTool({
  name: "ask_human", description: "Pause until the operator answers this question.",
  parameters: obj({ question: str({ maxLength: 4096 }) }), replay: "safe",
  async execute({ question }, api, context) {
    const key = String(api.taskId);
    await api.commit(async tx => {
      const doc = await tx.doc(HumanInputs, api.conversationId);
      if (!doc.requests[key]) {
        if (Object.keys(doc.requests).length >= 100) throw new Error("Human input retention limit reached");
        doc.requests[key] = { question };
      }
    }, context);
    const watch = (await api.watchDoc(HumanInputs, api.conversationId, context))!;
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const read = (value: typeof watch.value) => {
          const answer = value.requests[key]?.answer;
          if (answer !== undefined) resolve(answer);
        };
        read(watch.value);
        watch.start(async call => { if (call.kind === "value") read(call.value); });
        void watch.closed.then(() => reject(new Error("Human input wait interrupted")));
      });
      return { output: [{ type: "text", text: answer }] };
    } finally { await watch.stop(); }
  },
});
