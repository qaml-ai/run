import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fileChars, validFileRef } from "./files.ts";
import type { CompactionState, Transcript } from "./transcript.ts";

const HISTORY_BYTES = 16 * 1024 * 1024;
const invalid = (message: string) => new Error(`INVALID_HISTORY: ${message}`);
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
/** Text, image and file blocks: what a user message or a tool result may carry. */
const inputBlock = (part: any) => isObject(part) && (part.type === "text" && typeof part.text === "string" || part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string" || validFileRef(part));

/**
 * Imported history (an agent's `initialMessages`): native Pi messages, kept as they are, so reasoning and
 * signatures are never reconstructed. Each is checked for what the model call and history need, and a
 * refusal names the message (`INVALID_HISTORY`, 400); past 16 MB of JSON it is `HISTORY_TOO_LARGE` (413).
 */
export function validateInitialMessages(messages: AgentMessage[]) {
  if (!Array.isArray(messages)) throw invalid("initialMessages must be an array of messages");
  messages.forEach((message: any, index) => {
    const at = `initialMessages[${index}]`;
    if (!isObject(message)) throw invalid(`${at} must be a message object`);
    if (message.role === "user") {
      if (typeof message.content !== "string" && !(Array.isArray(message.content) && message.content.every(inputBlock))) throw invalid(`${at}: a user message's content is a string or an array of text, image and file blocks`);
    } else if (message.role === "assistant") {
      if (!Array.isArray(message.content)) throw invalid(`${at}: an assistant message's content is an array of text, thinking and toolCall blocks`);
      message.content.forEach((part: any, block: number) => {
        if (!isObject(part)) throw invalid(`${at}: content[${block}] must be a block object`);
        if (part.type === "text" && typeof part.text === "string" || part.type === "thinking" && typeof part.thinking === "string") return;
        if (part.type === "toolCall") {
          if (typeof part.id !== "string" || !part.id || typeof part.name !== "string" || !part.name || !isObject(part.arguments)) throw invalid(`${at}: content[${block}]: a toolCall needs id, name and arguments (an object)`);
          return;
        }
        throw invalid(`${at}: an assistant message's content is an array of text, thinking and toolCall blocks`);
      });
    } else if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !message.toolCallId || typeof message.toolName !== "string" || !Array.isArray(message.content) || !message.content.every(inputBlock)) {
        throw invalid(`${at}: a toolResult needs toolCallId, toolName and content (an array of text, image and file blocks)`);
      }
    } else if (message.role === "compactionSummary") {
      if (typeof message.summary !== "string" || !message.summary.trim()) throw invalid(`${at}: a compactionSummary needs its summary`);
    } else throw invalid(`${at} has role ${JSON.stringify(message.role)}; a message is user, assistant, toolResult or compactionSummary`);
  });
  const bytes = Buffer.byteLength(JSON.stringify(messages));
  if (bytes > HISTORY_BYTES) {
    throw Object.assign(new Error(`HISTORY_TOO_LARGE: initialMessages is ${(bytes / 1024 / 1024).toFixed(1)} MB of JSON; at most 16 MB. Import the most recent messages that fit, after a compactionSummary of the rest`), { status: 413 });
  }
}

/**
 * Imported history as the transcript keeps it: its messages without compaction summaries, and the last
 * summary as the compaction it stands for, cut where it sat. The model then sees that summary and what
 * follows it; history still has every message.
 */
export function importedHistory(initial: AgentMessage[]): { messages: AgentMessage[]; compaction?: CompactionState } {
  const messages: AgentMessage[] = [];
  let compaction: CompactionState | undefined;
  for (const message of initial as any[]) {
    if (message.role !== "compactionSummary") { messages.push(message); continue; }
    const at = typeof message.timestamp === "number" ? message.timestamp : Date.parse(message.timestamp ?? "");
    compaction = { summary: message.summary, cut: messages.length, tokensBefore: Number(message.tokensBefore) || 0, at: Number.isFinite(at) ? at : Date.now() };
  }
  return { messages, ...(compaction ? { compaction } : {}) };
}

/** Scoped callers may only add user input; assistant and tool history is runtime-owned. */
export function validateUserMessages(messages: AgentMessage[]) {
  if (!Array.isArray(messages) || messages.some(message => !message || message.role !== "user")) throw new Error("Only user messages can be submitted; assistant and tool results are produced by the runtime");
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    if (!Array.isArray(message.content) || message.content.some(part => !part || !(part.type === "text" && typeof part.text === "string" || part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string"))) {
      throw new Error("User messages may only contain text and images");
    }
  }
  if (Buffer.byteLength(JSON.stringify(messages)) > HISTORY_BYTES) throw new Error("Messages exceed 16 MB");
}

/**
 * Messages that close a turn a runtime restart interrupted. Tool calls without
 * results get an explicit "outcome unknown" result, so the agent stays usable
 * without an operator, and the model is never told an effect did or did not
 * happen. They are appended: an interrupted turn's open calls are always at the end.
 * Without `close`, only the tool results are added, so the turn can continue. Calls `awaiting` a
 * person's input are left open: their results come when the input is answered.
 */
export function interruptedTurnRepairs(messages: AgentMessage[], close = true, awaiting: string[] = []): AgentMessage[] {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      pending.clear();
      for (const part of message.content) if (part.type === "toolCall") pending.set(part.id, part.name);
    } else if (message.role === "toolResult") pending.delete(message.toolCallId);
    else if (message.role === "user") pending.clear();
  }
  for (const id of awaiting) pending.delete(id);
  const repairs: AgentMessage[] = [...pending].map(([toolCallId, toolName]) => ({
    role: "toolResult", toolCallId, toolName, isError: true, timestamp: Date.now(),
    content: [{ type: "text", text: "The runtime restarted while this tool call was in progress. Its outcome is unknown: it may or may not have taken effect. Check the current state before repeating it." }],
  }));
  // Without this, continue() would resubmit a user-only interrupted turn as if it were new.
  if (close) repairs.push({ role: "user", content: "[Runtime notice] The previous run was interrupted by a restart before it finished. Tool results above marked as unknown may or may not have taken effect. Wait for the next instruction.", timestamp: Date.now() });
  return repairs;
}

/**
 * Settle a turn the transcript holds open that nothing will continue: its open calls are answered as unknown (never made
 * again), and it is marked ended, durably. A turn suspended on a person's input keeps those calls open and stays
 * suspended; any other gets a runtime notice, so a later continue does not resubmit it. Whether there was one to settle.
 */
export async function closeInterruptedTurn(transcript: Transcript): Promise<boolean> {
  let closed = false;
  // One commit, its records worked out as of every earlier one: a turn closed already is left alone, and a call that has
  // a result (one an earlier close gave it, too) is never answered again.
  await transcript.commit(() => {
    if (!transcript.active) return [];
    closed = true;
    const awaiting = transcript.awaiting;
    return [...interruptedTurnRepairs(transcript.context, !awaiting.length, awaiting).map(message => ({ t: "message" as const, message })), { t: "turn" as const, active: false }];
  });
  return closed;
}

export function recoverInterruptedTurn(messages: AgentMessage[]): AgentMessage[] {
  return [...messages, ...interruptedTurnRepairs(messages)];
}

/** Approximate prompt characters for a message; an image counts like pi's estimate, not by its base64 size, and a file reference by what it stands for. */
export function messageChars(message: AgentMessage): number {
  let extra = 0;
  const text = JSON.stringify(message, (key, value) => {
    if (key === "data" && typeof value === "string" && value.length > 256) { extra += 4800; return ""; }
    if (value?.type === "file" && validFileRef(value)) { extra += fileChars(value); return undefined; }
    return value;
  });
  return text.length + extra;
}

/**
 * Last-resort bound on provider context, used only when compaction could not run:
 * drop whole older user turns until the rest fits `budgetTokens` (pi's chars/4
 * estimate, the same measure compaction uses). Durable history stays complete.
 */
export function boundedContext(messages: AgentMessage[], budgetTokens: number): AgentMessage[] {
  const budget = Math.max(1024, budgetTokens) * 4;
  let size = 0;
  let start = -1;
  // Walk back from the newest message, remembering the oldest user turn that still fits.
  for (let index = messages.length - 1; index >= 0; index--) {
    size += messageChars(messages[index]);
    if (size > budget) break;
    if (messages[index].role === "user" || messages[index].role === "compactionSummary") start = index;
  }
  if (size <= budget) return messages;
  if (start < 0) throw new Error("The current turn exceeds the model context budget; use smaller tool results or a larger-context model");
  return messages.slice(start);
}
