import { Buffer } from "node:buffer";
import { TierError, tierFetch, type TierEnv } from "./tier.ts";

export const BASH_OUTPUT_KEEP = 32 * 1024;
const HALF = BASH_OUTPUT_KEEP / 2;

class Output {
  bytes = 0;
  private head = Buffer.alloc(HALF);
  private tail = Buffer.alloc(HALF);

  append(chunk: Buffer) {
    const headSize = Math.max(0, Math.min(chunk.length, HALF - this.bytes));
    if (headSize) chunk.copy(this.head, this.bytes, 0, headSize);
    const rest = chunk.subarray(headSize);
    const end = this.bytes + chunk.length;
    const kept = rest.subarray(Math.max(0, rest.length - HALF));
    const start = (end - kept.length) % HALF;
    this.tail.set(kept.subarray(0, HALF - start), start);
    this.tail.set(kept.subarray(HALF - start), 0);
    this.bytes = end;
  }

  text() {
    const head = this.head.subarray(0, Math.min(this.bytes, HALF));
    if (this.bytes <= BASH_OUTPUT_KEEP)
      return Buffer.concat([head, this.tail.subarray(0, Math.max(0, this.bytes - HALF))]).toString("utf8");
    const at = this.bytes % HALF;
    const tail = Buffer.concat([this.tail.subarray(at), this.tail.subarray(0, at)]);
    return head.toString("utf8") + `\n[… ${(this.bytes - BASH_OUTPUT_KEEP).toLocaleString("en-US")} bytes truncated …]\n` + tail.toString("utf8");
  }
}

type Exit = { code: number; timedOut: boolean; ms: number; truncated?: boolean };
export type BashResult = {
  stdout: string; stderr: string; exitCode: number | null; timedOut: boolean;
  truncated: boolean; error?: string; checkpointError?: string;
};

type Request = Parameters<typeof tierFetch>[1];

async function requireStream(response: Response, path: string) {
  if (response.ok && response.headers.get("Content-Type")?.split(";")[0] === "text/event-stream") return;
  const body = await response.json().catch(() => null) as { error?: { code?: string } | string } | null;
  const code = typeof body?.error === "string" ? body.error : body?.error?.code;
  throw new TierError(response.status, code ?? "invalid_response", "Bash stream unavailable", undefined, path);
}

export async function bashStream(env: TierEnv, request: Request, execId: string, until: number, onOutput: () => void) {
  const output = { stdout: new Output(), stderr: new Output() };
  let offset = 0, missing = false, exit: Exit | undefined;
  async function read(response: Response) {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!exit) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let separator = /\r?\n\r?\n/.exec(buffer); separator && !exit; separator = /\r?\n\r?\n/.exec(buffer)) {
          const frame = buffer.slice(0, separator.index).split(/\r?\n/);
          buffer = buffer.slice(separator.index + separator[0].length);
          const event = frame.find(line => line.startsWith("event:"))?.slice(6).trim();
          const data = frame.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (event === "exit") exit = JSON.parse(data) as Exit;
          if (event !== "stdout" && event !== "stderr") continue;
          const chunk = JSON.parse(data) as { offset: number; data: string };
          const bytes = Buffer.from(chunk.data, "base64");
          const end = chunk.offset + bytes.length;
          if (end <= offset) continue;
          if (chunk.offset > offset) missing = true;
          if (offset === 0) onOutput();
          output[event].append(bytes.subarray(Math.max(0, offset - chunk.offset)));
          offset = end;
        }
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
  }

  const initial = await tierFetch(env, { ...request, timeoutMs: Math.max(1, until - Date.now()) });
  await requireStream(initial, request.path);
  await read(initial).catch(() => {});
  const path = request.path + "/" + execId;
  while (!exit && Date.now() < until) {
    const previous = offset;
    try {
      const tail = await tierFetch(env, {
        method: "GET", path, claims: request.claims, query: { offset },
        timeoutMs: Math.min(10_000, Math.max(1, until - Date.now())),
      });
      await requireStream(tail, path);
      await read(tail);
    } catch (error) {
      if (error instanceof TierError && [404, 409, 410].includes(error.status)) break;
    }
    if (!exit && previous === offset) await new Promise(resolve => setTimeout(resolve, 100));
  }
  const bytes = output.stdout.bytes + output.stderr.bytes;
  const result: BashResult = {
    stdout: output.stdout.text(), stderr: output.stderr.text(), exitCode: exit?.code ?? null,
    timedOut: exit?.timedOut ?? false,
    truncated: !exit || missing || !!exit.truncated || output.stdout.bytes > BASH_OUTPUT_KEEP || output.stderr.bytes > BASH_OUTPUT_KEEP,
    ...(!exit ? { error: "Bash output ended before an exit status was available" } : {}),
  };
  return { result, bytes, ms: exit?.ms };
}
