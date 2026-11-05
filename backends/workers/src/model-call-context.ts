import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";

/** Pi's compactor makes a separate two-message request with its own system prompt. */
export function modelCallKind(context: TranscriptContext): "response" | "compaction" {
  const first = context.messages[0];
  return context.messages.length === 2 && first?.role === "system"
    && typeof first.content === "string"
    && first.content.startsWith("You are a context summarization assistant.")
    ? "compaction" : "response";
}

/** Endpoint usage names the upstream provider too; Bedrock's region is transport, not its model id. */
export function accountingModel<T extends Model<Api>>(model: T, endpointIdentity?: boolean): T {
  if (!endpointIdentity) return model;
  const [provider, ...parts] = model.id.split("/");
  if (provider === "amazon-bedrock") parts.shift();
  return { ...model, provider: `${model.provider}/${provider}`, id: parts.join("/") };
}
