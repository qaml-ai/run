import type { ToolFiles } from "./tool-files.ts";
import { isFileArgument, fileMode, resolveFiles } from "./tool-file-schema.ts";

/** Stream multipart bodies with a known length, retaining each file's name and MIME. */
export async function multipartBody(value: unknown, files: ToolFiles | undefined, schema: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object of form fields');
  const boundary = `camelrun-${crypto.randomUUID()}`;
  const parts: (Uint8Array | ReadableStream<Uint8Array>)[] = []; let length = 0;
  const text = (value: string) => { const bytes = new TextEncoder().encode(value); parts.push(bytes); length += bytes.byteLength; };
  const quoted = (value: string) => value.replace(/[\r\n"\\]/g, char => encodeURIComponent(char));
  const append = async (name: string, value: unknown, fieldSchema: any) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) { for (const item of value) await append(name, item, fieldSchema?.items); return; }
    const field = quoted(name);
    if (isFileArgument(value) && fileMode(fieldSchema, name) !== 'url') {
      if (!files) throw new Error('This agent has no files to send: it has no volumes mounted');
      const file = await files.bodyFile(value);
      text(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${quoted(file.name)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`);
      parts.push(file.stream); length += file.size; text('\r\n');
    } else {
      const resolved = await resolveFiles(value, fieldSchema, files, name);
      text(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${typeof resolved === 'string' ? resolved : JSON.stringify(resolved)}\r\n`);
    }
  };
  for (const [name, entry] of Object.entries(value as object)) await append(name, entry, schema?.properties?.[name]);
  text(`--${boundary}--\r\n`);
  let index = 0, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    while (index < parts.length) { const part = parts[index]; if (part instanceof Uint8Array) { index++; controller.enqueue(part); return; }
      reader ??= part.getReader(); const next = await reader.read(); if (!next.done) { controller.enqueue(next.value); return; } reader.releaseLock(); reader = undefined; index++; }
    controller.close();
  }, async cancel() { await reader?.cancel(); } });
  return { body, length, contentType: `multipart/form-data; boundary=${boundary}` };
}
