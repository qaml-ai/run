import type { Message } from "@earendil-works/pi-ai";

/** OpenRouter may reuse a call ID in a later response. Responses needs a unique call ID
 * for each pair in the replayed input. Rename the later pairs only in that request. */
export function uniqueResponsesCallIds(messages: Message[]): Message[] {
  const reserved = new Set<string>();
  let repeated = false;
  for (const message of messages) {
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
    const round = new Set<string>();
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      // Two identical calls in one response are ambiguous. Leave their validation to the provider.
      if (round.has(part.id)) return messages;
      round.add(part.id);
      const callId = part.id.split("|", 1)[0];
      if (reserved.has(callId)) repeated = true;
      reserved.add(callId);
    }
  }
  if (!repeated) return messages;

  const seen = new Set<string>();
  const roundAliases = new Map<string, string>();
  let next = 0;
  return messages.map(message => {
    if (message.role === "toolResult") {
      const alias = roundAliases.get(message.toolCallId);
      return alias ? { ...message, toolCallId: alias } : message;
    }
    if (message.role !== "assistant") return message;
    roundAliases.clear();
    if (message.stopReason === "error" || message.stopReason === "aborted") return message;
    const content = message.content.map(part => {
      if (part.type !== "toolCall") return part;
      const callId = part.id.split("|", 1)[0];
      if (!seen.has(callId)) {
        seen.add(callId);
        return part;
      }
      let alias: string;
      do { alias = `call_camel_replay_${++next}`; } while (reserved.has(alias));
      roundAliases.set(part.id, alias);
      // The optional Responses item ID can also be reused. Omit it on the rewritten call.
      return { ...part, id: alias };
    });
    return roundAliases.size ? { ...message, content } : message;
  });
}
