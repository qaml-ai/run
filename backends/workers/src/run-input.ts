import { ApiError } from "./api-contract.ts";

/** Preserve the source run API's text/file part order and legacy files field. */
export function runInput(input: unknown, files?: unknown) {
  const parts = typeof input === "string" ? [{ type: "text", text: input }] : input;
  if (!Array.isArray(parts) || !parts.length || parts.some(part =>
    !part || typeof part !== "object" ||
    (part.type !== "file" && (part.type !== "text" || typeof part.text !== "string"))
  )) throw new ApiError(400, "Run input must contain text or file parts");
  if (files !== undefined && !Array.isArray(files)) throw new ApiError(400, "files must be an array");
  const text = parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n\n");
  const attached = [
    ...parts.flatMap(part => part.type === "file"
      ? [Object.fromEntries(Object.entries(part).filter(([key, value]) => key !== "type" && value !== undefined))]
      : []),
    ...((files ?? []) as unknown[]),
  ];
  if (!text.trim() && !attached.length) throw new ApiError(400, "input: give the run some text, or audio to transcribe");
  return { text, files: attached };
}
