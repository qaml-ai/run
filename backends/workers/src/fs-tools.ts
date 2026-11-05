import type { ToolRegistration } from "@earendil-works/pi-durable";

const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
const valueOf = (result: Awaited<ReturnType<ToolRegistration["execute"]>>) => {
  if (result.structuredOutput !== undefined) return result.structuredOutput;
  const value = result.output?.find(part => part.type === "text")?.text ?? "";
  try { return JSON.parse(value); } catch { return value; }
};

/** Keep native mount, version and output policies while exposing values to scripts. */
export function compatibleFileTools(tools: ToolRegistration[]): ToolRegistration[] {
  return tools.map(tool => {
    if (tool.name === "read") return {
      ...tool,
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" }, encoding: { enum: ["utf8", "base64"] }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 }, length: { type: "integer", minimum: 1, maximum: 131072 } }, additionalProperties: false },
      structuredOutputSchema: {},
      async execute(input, api, context) {
        const { path, encoding, offset = 0, length = 131072 } = input as { path: string; encoding?: string; offset?: number; length?: number };
        let result;
        try {
          result = await tool.execute(encoding === undefined && !("length" in (input as object))
            ? input : { path, encoding: "base64", offset, length }, api, context);
        } catch (error) {
          if ((error as { status?: number }).status === 404 || /FILE_404:/.test(String(error)))
            throw new Error(`File ${path} does not exist`);
          throw error;
        }
        if (encoding === undefined && !("length" in (input as object)))
          return { ...result, structuredOutput: result.output?.find(part => part.type === "text")?.text ?? "" };
        const read = valueOf(result) as { data: string; nextOffset?: number };
        const data = encoding === "utf8" ? new TextDecoder().decode(Uint8Array.from(atob(read.data), char => char.charCodeAt(0))) : read.data;
        const value = { ...read, path, data, content: data, encoding: encoding ?? "base64" };
        return { ...text(value), structuredOutput: value };
      },
    };
    if (tool.name === "write") return {
      ...tool,
      structuredOutputSchema: {},
      async execute(input, api, context) {
        const { path, content, text: contentAlias, encoding } = input as { path: string; content?: string; text?: string; encoding?: string };
        const data = content ?? contentAlias;
        if (data === undefined) throw new Error("content is required");
        if (encoding === "base64") {
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error("Invalid base64 file content");
        }
        const result = await tool.execute(input, api, context);
        return { ...result, structuredOutput: valueOf(result) };
      },
    };
    if (tool.name === "ls") return {
      ...tool, structuredOutputSchema: {},
      async execute(args, api, context) {
        const result = await tool.execute(args, api, context);
        const value = valueOf(result);
        const path = String((args as { path?: string }).path ?? "/workspace").replace(/^\/workspace(?=\/|$)/, "").replace(/\/+$/, "");
        const entries = Array.isArray(value) ? value.map(entry => {
          const entryPath = String(entry.path).replace(/^\/workspace(?=\/|$)/, "");
          return { ...entry, name: entryPath.slice(entryPath.startsWith(path + "/") ? path.length + 1 : 1).split("/")[0] };
        }) : value.entries ?? [];
        const seen = new Set<string>();
        const listing = { entries: entries.filter((entry: { name: string }) => !seen.has(entry.name) && !!seen.add(entry.name)), truncated: false };
        return { ...text(listing), structuredOutput: listing };
      },
    };
    return { ...tool, structuredOutputSchema: {}, async execute(args, api, context) {
      const result = await tool.execute(args, api, context);
      return { ...result, structuredOutput: valueOf(result) };
    } };
  });
}
