import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { FILE_LIMITS } from "./limits.ts";

/** Leave room below provider limits, including through aggregators and tenant endpoints. */
export function requestImageLimit(model: Pick<Model<Api>, "provider" | "id" | "api">): number {
  const anthropic = model.api === "anthropic-messages" || /(?:^|[/.])anthropic(?:[/.]|$)/i.test(`${model.provider}/${model.id}`);
  return anthropic ? FILE_LIMITS.requestAnthropicImages : FILE_LIMITS.requestImages;
}

/** Newest images win. Copy only changed messages; never edit the persisted Pi transcript. */
export function capRequestImages(messages: Message[], model: Pick<Model<Api>, "provider" | "id" | "api">): Message[] {
  const limit = requestImageLimit(model);
  let images = 0;
  return messages.slice().reverse().map(message => {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.slice().reverse().map(block => {
      // PDFs use Pi's image block as transport but have a separate file budget.
      if (block.type !== "image" || block.mimeType === "application/pdf" || ++images <= limit) return block;
      changed = true;
      return { type: "text" as const, text: `[image omitted: older than the last ${limit} images]` };
    }).reverse();
    return changed ? { ...message, content } as Message : message;
  }).reverse();
}
