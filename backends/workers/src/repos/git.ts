const encoder = new TextEncoder();
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}
export async function gitHash(kind: "blob" | "tree" | "commit", bytes: Uint8Array): Promise<string> {
  const header = encoder.encode(`${kind} ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header); object.set(bytes, header.length);
  return hex(await crypto.subtle.digest("SHA-1", object));
}
export const gitBlobSha1 = (bytes: Uint8Array): Promise<string> => gitHash("blob", bytes);
export async function commitObject(input: {
  tree: string; parents: string[]; author: string; at: number; message: string; trailers: Record<string, string>;
}): Promise<{ id: string; bytes: Uint8Array }> {
  const seconds = Math.floor(input.at / 1000);
  const bytes = encoder.encode(`tree ${input.tree}\n` + input.parents.map(p => `parent ${p}\n`).join("") +
    `author ${input.author} <${input.author}@camelfs> ${seconds} +0000\n` +
    `committer camelfs <camelfs@camelfs> ${seconds} +0000\n\n${input.message}\n\n` +
    Object.entries(input.trailers).map(([k, v]) => `${k}: ${v}\n`).join(""));
  return { id: await gitHash("commit", bytes), bytes };
}
/** Match camelfsd Commit(): retain identity headers and split trailers at the last blank line. */
export function parseCommit(bytes: Uint8Array): {
  tree: string; parents: string[]; author: string; committer: string; message: string; trailers: Record<string, string>;
} {
  const text = new TextDecoder().decode(bytes), split = text.indexOf("\n\n");
  const headers = split < 0 ? text : text.slice(0, split), body = split < 0 ? "" : text.slice(split + 2);
  const out = { tree: "", parents: [] as string[], author: "", committer: "", message: body, trailers: {} as Record<string, string> };
  for (const line of headers.split("\n")) {
    const i = line.indexOf(" "), key = line.slice(0, i), value = line.slice(i + 1);
    if (key === "parent") out.parents.push(value);
    else if (key === "tree" || key === "author" || key === "committer") out[key] = value;
  }
  const last = body.lastIndexOf("\n\n");
  if (last >= 0) {
    out.message = body.slice(0, last);
    for (const line of body.slice(last + 2).replace(/\n$/, "").split("\n")) {
      const i = line.indexOf(": ");
      if (i >= 0) Object.defineProperty(out.trailers, line.slice(0, i), { value: line.slice(i + 2), enumerable: true, configurable: true, writable: true });
    }
  }
  return out;
}
