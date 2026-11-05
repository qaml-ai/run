import type { Api, AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentTools, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { forcedToolChoice, OUTPUT_INSTRUCTIONS, OUTPUT_REMINDER } from "./output-policy.ts";

type Settings = { requestId?: string; thinkingLevel?: string; outputReminded?: boolean; output?: { schema?: Record<string, unknown> } };

/** The choice budget and text reminder belong to one user request, across its model calls. */
export class OutputRequest {
  private request?: string;
  private count = 0;
  private refused = false;
  private reminded = false;

  prepare(model: Model<Api>, context: TranscriptContext, settings: Settings) {
    const request = settings.requestId ?? String(context.messages.find(message => message.role === "user")?.timestamp ?? 0);
    if (this.request !== request) {
      this.request = request;
      this.count = 0;
      this.refused = false;
      this.reminded = !!settings.outputReminded;
    }
    const schema = settings.output?.schema;
    let toolChoice: unknown;
    if (schema) {
      const sole = getCurrentTools(context.messages).every(tool => tool.name === "final_output");
      const tool = { name: "final_output", description: "Give the final answer as the arguments of this tool. The turn ends when the answer is accepted.", parameters: schema };
      context = normalizeContext({ messages: [...context.messages, { role: "system", content: "", sections: { structured_output: OUTPUT_INSTRUCTIONS + (this.reminded ? `\n${OUTPUT_REMINDER}` : "") }, toolsAdded: [tool], timestamp: Date.now() }] });
      if ((sole || this.reminded) && !this.refused && this.count < 3) {
        toolChoice = forcedToolChoice(model, "final_output", { sole, thinking: (settings.thinkingLevel ?? "off") !== "off" });
        if (toolChoice !== undefined) this.count++;
      }
    } else {
      context = normalizeContext({ messages: [...context.messages, { role: "system", content: "", sections: { structured_output: null }, toolsRemoved: [{ name: "final_output" }], timestamp: Date.now() }] });
    }
    return { context, toolChoice };
  }

  refuse() { this.refused = true; }

  /** Reissue the original prompt, without making the discarded answer a new conversation turn. */
  remind(message: AssistantMessage, settings: Settings) {
    if (!settings.output?.schema || this.reminded || message.stopReason !== "stop") return false;
    this.reminded = true;
    return true;
  }
}
