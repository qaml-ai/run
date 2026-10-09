/**
 * A tar archive (POSIX ustar) written as a stream, for a directory sent to a tool (file-arguments.ts): each file's
 * 512-byte header, its bytes, and zeros to the next 512. A name too long for ustar's fields goes in a PAX header first.
 */
export type TarFile = { name: string; size: number; mtime: number; stream(): AsyncIterable<Uint8Array> };

const BLOCK = 512;

/** The archive of `files`, a piece at a time; each file's stream must give exactly its `size` bytes. */
export async function* tar(files: Iterable<TarFile> | AsyncIterable<TarFile>): AsyncGenerator<Uint8Array> {
  for await (const file of files) {
    yield* headers(file);
    let written = 0;
    for await (const chunk of file.stream()) {
      written += chunk.byteLength;
      yield chunk;
    }
    if (written !== file.size) throw new Error(`${file.name} changed size while it was archived`);
    const padding = (BLOCK - file.size % BLOCK) % BLOCK;
    if (padding) yield Buffer.alloc(padding);
  }
  // Two empty blocks end the archive.
  yield Buffer.alloc(BLOCK * 2);
}

/** A file's header, after a PAX header with its path when ustar's name (100 bytes) and prefix (155) cannot hold it. */
function headers(file: TarFile): Buffer[] {
  const mtime = Math.floor(file.mtime / 1000);
  const split = fit(file.name);
  if (split) return [header(split.name, split.prefix, file.size, mtime, "0")];
  const record = pax("path", file.name);
  return [header("PaxHeader", "", record.length, mtime, "x"), record, Buffer.alloc((BLOCK - record.length % BLOCK) % BLOCK), header(truncate(file.name), "", file.size, mtime, "0")];
}

/** `name` as ustar's name and prefix fields, split at a slash, if it fits them. */
function fit(name: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  for (let slash = name.indexOf("/"); slash > 0; slash = name.indexOf("/", slash + 1)) {
    const prefix = name.slice(0, slash), rest = name.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { name: rest, prefix };
  }
  return undefined;
}

/** A name cut to 100 bytes, for readers that ignore PAX headers. */
function truncate(name: string) {
  let cut = name.slice(-100);
  while (Buffer.byteLength(cut) > 100) cut = cut.slice(1);
  return cut;
}

/** One PAX record, `<length> <key>=<value>\n`, whose length counts its own digits. */
function pax(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`);
}

function header(name: string, prefix: string, size: number, mtime: number, type: "0" | "x"): Buffer {
  const block = Buffer.alloc(BLOCK);
  const put = (text: string, offset: number, length: number) => block.write(text, offset, length, "utf8");
  const octal = (value: number, offset: number, length: number) => put(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
  put(name, 0, 100);
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(mtime, 136, 12);
  put(" ".repeat(8), 148, 8);
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}
