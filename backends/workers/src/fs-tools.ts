import type { ToolRegistration } from "@earendil-works/pi-durable";

type FileRequest = (path: string, init: RequestInit) => Promise<Response>;
const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });

/** Add byte windows needed by the shared fs shim without changing the volume API. */
export function compatibleFileTools(tools: ToolRegistration[], request: FileRequest): ToolRegistration[] {
  return tools.map(tool => {
    if (tool.name === "read") return {
      ...tool,
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" }, encoding: { enum: ["utf8", "base64"] }, offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 131072 } }, additionalProperties: false },
      structuredOutputSchema: { type: "object" },
      async execute(input) {
        const { path, encoding = "utf8", offset = 0, length = 131072 } = input as { path: string; encoding?: string; offset?: number; length?: number };
        const response = await request(path, { method: "GET" });
        if (!response.ok) {
          if (response.status === 404) throw new Error(`File ${path} does not exist`);
          throw new Error(`File read failed (${response.status})`);
        }
        // File APIs cap stored files at 32 MiB; each tool result remains 128 KiB.
        const bytes = new Uint8Array(await response.arrayBuffer()), part = bytes.subarray(offset, offset + length);
        const data = encoding === "base64" ? encodeBase64(part) : new TextDecoder().decode(part);
        const value = { path, data, content: data, encoding, ...(offset + length < bytes.length ? { nextOffset: offset + length } : {}) };
        return { ...text(value), structuredOutput: value };
      },
    };
    if (tool.name === "write") return {
      ...tool,
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" }, content: { type: "string" }, text: { type: "string" }, encoding: { enum: ["utf8", "base64"] } }, additionalProperties: false },
      async execute(input) {
        const { path, content, text: contentAlias, encoding } = input as { path: string; content?: string; text?: string; encoding?: string };
        const data = content ?? contentAlias;
        if (data === undefined) throw new Error("content is required");
        let bytes: Uint8Array;
        if (encoding === "base64") {
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error("Invalid base64 file content");
          bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        } else bytes = new TextEncoder().encode(data);
        const response = await request(path, { method: "PUT", body: bytes, headers: { "Content-Type": encoding === "base64" ? "application/octet-stream" : "text/plain; charset=utf-8" } });
        if (!response.ok) throw new Error(`File write failed (${response.status})`);
        return text(await response.json());
      },
    };
    if (tool.name === "ls") return {
      ...tool, structuredOutputSchema: { type: "object" },
      async execute(args, api, context) {
        const result = await tool.execute(args, api, context);
        const value = JSON.parse(result.output?.find(part => part.type === "text")?.text ?? "[]");
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
    return tool;
  });
}

function encodeBase64(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(text);
}
