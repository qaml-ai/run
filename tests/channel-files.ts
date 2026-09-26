import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ChannelFiles } from "../src/channels.ts";
import type { FileRef } from "../src/files.ts";

/** An agent's workspace in memory, standing in for volumes behind a Channels instance. */
export function memoryFiles() {
  const saved = new Map<string, { data: Buffer; contentType?: string }>();
  const ref = (path: string, size?: number): FileRef => {
    const file = saved.get(path);
    if (!file) throw new Error(`${path} does not exist`);
    return { type: "file", path, volume: "vol_fixture", version: 1, size: size ?? file.data.length, contentType: file.contentType ?? "application/octet-stream", chunks: [createHash("sha256").update(file.data).digest("hex")] };
  };
  const files: ChannelFiles = {
    async upload(_agent, _tenant, requestId, name, source, contentType) {
      const parts: Uint8Array[] = [];
      for await (const part of source) parts.push(part);
      const path = `/workspace/uploads/${requestId}/${name}`;
      saved.set(path, { data: Buffer.concat(parts), ...(contentType ? { contentType } : {}) });
      return { path };
    },
    ref: async (_agent, _tenant, path) => ref(path),
    async *read(_tenant, file) { yield saved.get(file.path)!.data; },
    link: async (_agent, _tenant, path) => `https://agents.example.test/v1/links/fixture${path}`,
  };
  /** A file the agent made and presents; `size` overrides its recorded size (a file too large to send). */
  const present = (path: string, data: Buffer, contentType: string, options: { caption?: string; size?: number } = {}) => {
    saved.set(path, { data, contentType });
    return { ...ref(path, options.size), ...(options.caption ? { caption: options.caption } : {}) };
  };
  return { files, saved, present };
}

/** A fake service's request body: JSON, form fields, or multipart with files as {name, type, data}. */
export async function requestBody(req: IncomingMessage, raw: Buffer): Promise<any> {
  const type = req.headers["content-type"] ?? "";
  if (!raw.length) return {};
  if (type.startsWith("multipart/form-data")) {
    const form = await new Response(new Uint8Array(raw), { headers: { "content-type": type } }).formData();
    const body: Record<string, unknown> = {};
    for (const [key, value] of form) body[key] = typeof value === "string" ? value : { name: value.name, type: value.type, data: Buffer.from(await value.arrayBuffer()) };
    return body;
  }
  if (type.startsWith("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw.toString()));
  try { return JSON.parse(raw.toString()); } catch { return { raw }; }
}
