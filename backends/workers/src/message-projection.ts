import type { Message, AssistantMessage } from "@earendil-works/pi-ai";

/** Project durable snapshots into the same deltas that the public SDK consumes. */
export class MessageProjection {
  private seen = new Map<number, AssistantMessage | true>();

  events(message: Message, ended: boolean): object[] {
    const before = this.seen.get(message.timestamp);
    const events: object[] = [];
    if (!before) events.push({ type: "message_start", message });
    if (message.role === "assistant") {
      const previous = before && before !== true ? before : undefined;
      message.content.forEach((part, contentIndex) => {
        const prior = previous?.content[contentIndex];
        const push = (delta: object) =>
          events.push({
            type: "message_update",
            assistantMessageEvent: { ...delta, contentIndex },
          });
        if (part.type === "text" || part.type === "thinking") {
          const kind = part.type === "text" ? "text" : "thinking";
          const value = part.type === "text" ? part.text : part.thinking;
          const old =
            prior?.type === "text"
              ? prior.text
              : prior?.type === "thinking"
                ? prior.thinking
                : "";
          if (!prior) push({ type: `${kind}_start` });
          if (value.startsWith(old) && value.length > old.length)
            push({ type: `${kind}_delta`, delta: value.slice(old.length) });
        } else if (part.type === "toolCall") {
          if (!prior)
            push({ type: "toolcall_start", id: part.id, name: part.name });
          if (ended) push({ type: "toolcall_end", toolCall: part });
        }
      });
      this.seen.set(message.timestamp, ended ? true : structuredClone(message));
    } else this.seen.set(message.timestamp, true);
    if (ended && message.role !== "toolResult") events.push({ type: "message_end", message });
    if (ended && message.role === "assistant")
      for (const call of message.content)
        if (call.type === "toolCall")
          events.push({
            type: "tool_execution_start",
            toolCallId: call.id,
            toolName: call.name,
            args: call.arguments,
          });
    if (ended && message.role === "toolResult")
      events.push({
        type: "tool_execution_end",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        result: { content: message.content },
        isError: message.isError ?? false,
      }, { type: "message_end", message });
    if (this.seen.size > 256) this.seen.delete(this.seen.keys().next().value!);
    return events;
  }
}
