import { ApiError } from "./api-contract.ts";
import { object } from "./validation.ts";
import { attachmentInputs } from "./attachment-policy.ts";
import { outputInput } from "./output-validation.ts";
import { metadataInput, senderInput } from "./sender.ts";

/** Check a create's first prompt before provisioning anything; file reads happen after creation. */
export function firstPrompt(input: unknown) {
  if (input === undefined) return;
  const params = object(input, ["text", "files", "requestId", "metadata", "from", "actor", "allowDisconnected", "whileRunning", "spendLimit", "bucket", "endUser", "runLimits", "output", "history"]);
  if (params.text !== undefined && (typeof params.text !== "string" || new TextEncoder().encode(params.text).length > 100_000)) throw new ApiError(400, "Invalid prompt text");
  if (!(typeof params.text === "string" && params.text.trim()) && !(Array.isArray(params.files) && params.files.length)) throw new ApiError(400, 'Send {"text": "..."}, or attach audio to transcribe');
  if (params.files !== undefined) attachmentInputs(params.files);
  if (params.requestId !== undefined && (typeof params.requestId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(params.requestId))) throw new ApiError(400, "Invalid request id");
  if (params.metadata !== undefined) metadataInput(params.metadata);
  if (params.from !== undefined) senderInput(params.from);
  if (params.output !== undefined) outputInput(params.output);
  if (params.allowDisconnected !== undefined && typeof params.allowDisconnected !== "boolean") throw new ApiError(400, "allowDisconnected must be a boolean");
  if (params.whileRunning !== undefined && !["queue", "steer"].includes(String(params.whileRunning))) throw new ApiError(400, "Invalid whileRunning");
  const { requestId, ...rest } = params;
  return { id: requestId ?? crypto.randomUUID(), method: "prompt", params: rest };
}
