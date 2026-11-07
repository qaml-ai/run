/**
 * The file `edit` tool's arguments, repaired the way Pi's own edit tool repairs them (prepareEditArguments): models
 * often send a top-level `oldText`/`newText` pair, one edit object, or `edits` as a JSON string, rather than
 * `edits: [{oldText, newText}]`. Works on a copy; anything else passes through for validation to refuse.
 */
export function editArguments(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const args = { ...(input as Record<string, unknown>) };
  const single = (value: unknown): value is { oldText: string; newText: string } =>
    !!value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { oldText?: unknown }).oldText === "string" && typeof (value as { newText?: unknown }).newText === "string";
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
      else if (single(parsed)) args.edits = [parsed];
    } catch { /* left for validation */ }
  } else if (single(args.edits)) args.edits = [args.edits];
  if (typeof args.oldText !== "string" || typeof args.newText !== "string") return args;
  const { oldText, newText, ...rest } = args;
  return { ...rest, edits: [...(Array.isArray(args.edits) ? args.edits : []), { oldText, newText }] };
}
