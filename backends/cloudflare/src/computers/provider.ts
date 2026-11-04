import type { Files, DirectoryBackup, DirectoryBackupRecord } from "@cloudflare/sandbox";
import { workspacePath } from "../validation.ts";

export type ComputerRequest =
  | { op: "exec"; argv: string[]; timeoutMs?: number }
  | { op: "read"; path: string }
  | { op: "write"; path: string; content: string }
  | { op: "snapshot" | "restore"; name: string }
  | { op: "sleep" };
export interface ComputerProvider {
  exec(argv: string[], signal: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFile(path: string, signal: AbortSignal): Promise<string>;
  writeFile(path: string, content: string, signal: AbortSignal): Promise<void>;
  snapshot(name: string, signal: AbortSignal): Promise<void>;
  restore(name: string, signal: AbortSignal): Promise<void>;
  sleep(): Promise<void>;
}
export interface SnapshotStore { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> }
export type ContainerApi = Pick<Container, "running" | "images" | "start" | "setInactivityTimeout" | "exec" | "destroy" | "snapshotContainer">;
const OUTPUT_LIMIT = 64 * 1024;
const FILE_LIMIT = 1024 * 1024;

export async function readBounded(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("Computer output limit exceeded"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

// Native Container API. Lifecycle uses setInactivityTimeout, the native
// counterpart of the legacy Container class's sleepAfter property.
export class ContainerProvider implements ComputerProvider {
  readonly sleepAfter = 60_000;
  protected container: ContainerApi;
  protected store: SnapshotStore;
  constructor(container: ContainerApi, store: SnapshotStore) { this.container = container; this.store = store; }
  protected async ready() {
    if (!this.container.running) {
      this.container.start({ image: this.container.images.workspace, enableInternet: false });
      // Create the backup target in the writable layer. Renaming a directory
      // from an image's lower overlay layer fails with EXDEV during restore.
      const init = await this.container.exec(["mkdir", "-p", "/workspace"], { signal: AbortSignal.timeout(30_000) });
      if (await init.exitCode) throw new Error("Computer workspace initialization failed");
    }
    await this.container.setInactivityTimeout(this.sleepAfter);
  }
  protected async run(argv: string[], signal: AbortSignal, limit = OUTPUT_LIMIT, stdin?: string) {
    await this.ready();
    signal.throwIfAborted();
    const process = await this.container.exec(argv, { cwd: "/workspace", signal, stdin: stdin === undefined ? undefined : "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      const input = async () => {
        if (stdin === undefined) return;
        if (!process.stdin) throw new Error("Container stdin unavailable");
        const writer = process.stdin.getWriter();
        try { await writer.write(new TextEncoder().encode(stdin)); await writer.close(); }
        finally { writer.releaseLock(); }
      };
      const [stdout, stderr, exitCode] = await Promise.all([
        readBounded(process.stdout, limit), readBounded(process.stderr, OUTPUT_LIMIT), process.exitCode, input(),
      ]);
      return { stdout, stderr, exitCode };
    } catch (error) { process.kill(9); throw error; }
  }
  exec(argv: string[], signal: AbortSignal) { return this.run(argv, signal); }
  async readFile(path: string, signal: AbortSignal) {
    const result = await this.run(["node", "-e", 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', path], signal, FILE_LIMIT);
    if (result.exitCode) throw new Error("Computer file read failed");
    return result.stdout;
  }
  async writeFile(path: string, content: string, signal: AbortSignal) {
    const result = await this.run(["node", "-e", 'const fs=require("node:fs");fs.mkdirSync(require("node:path").dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],fs.readFileSync(0))', path], signal, OUTPUT_LIMIT, content);
    if (result.exitCode) throw new Error("Computer file write failed");
  }
  async snapshot(name: string, signal: AbortSignal) {
    await this.ready(); signal.throwIfAborted();
    const snapshot = await this.container.snapshotContainer({ name });
    await this.store.put(`snapshot:${name}`, snapshot);
  }
  async restore(name: string, signal: AbortSignal) {
    const snapshot = await this.store.get<ContainerSnapshot>(`snapshot:${name}`);
    if (!snapshot) throw new Error("Unknown computer snapshot");
    signal.throwIfAborted();
    await this.container.destroy();
    this.container.start({ containerSnapshot: snapshot, enableInternet: false });
    await this.container.setInactivityTimeout(this.sleepAfter);
  }
  async sleep() { await this.container.destroy(); }
}

// SDK 1.0 keeps execution on the native Container API and adds structured files
// and portable directory backups. It no longer exports the 0.x Sandbox class.
export class SandboxProvider extends ContainerProvider {
  private files: Pick<Files, "readFile" | "writeFile" | "mkdir">;
  private backups: Pick<DirectoryBackup, "backup" | "restore">;
  constructor(container: ContainerApi, store: SnapshotStore,
    files: Pick<Files, "readFile" | "writeFile" | "mkdir">,
    backups: Pick<DirectoryBackup, "backup" | "restore">) {
    super(container, store); this.files = files; this.backups = backups;
  }
  override async readFile(path: string, signal: AbortSignal) {
    await this.ready();
    const response = await this.files.readFile(path, { signal });
    return readBounded(response.body, FILE_LIMIT);
  }
  override async writeFile(path: string, content: string, signal: AbortSignal) {
    await this.ready();
    await this.files.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true, signal });
    await this.files.writeFile(path, content, { signal });
  }
  override async snapshot(name: string, signal: AbortSignal) {
    await this.ready();
    const backup = await this.backups.backup({ dir: "/workspace", name, signal });
    await this.store.put(`backup:${name}`, backup);
  }
  override async restore(name: string, signal: AbortSignal) {
    const backup = await this.store.get<DirectoryBackupRecord>(`backup:${name}`);
    if (!backup) throw new Error("Unknown computer backup");
    await this.ready();
    await this.backups.restore(backup, { signal });
  }
}

export async function operate(provider: ComputerProvider, request: ComputerRequest, signal: AbortSignal = AbortSignal.timeout(30_000)) {
  switch (request.op) {
    case "exec":
      if (!Array.isArray(request.argv) || request.argv.length < 1 || request.argv.length > 100 || request.argv.some(arg => typeof arg !== "string" || arg.includes("\0") || new TextEncoder().encode(arg).length > 16384)) throw new Error("Invalid argv");
      return provider.exec(request.argv, signal);
    case "read": return { content: await provider.readFile(workspacePath(request.path), signal) };
    case "write":
      if (typeof request.content !== "string" || new TextEncoder().encode(request.content).length > FILE_LIMIT) throw new Error("Computer file exceeds 1 MiB");
      await provider.writeFile(workspacePath(request.path), request.content, signal); return { written: true };
    case "snapshot": case "restore":
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(request.name)) throw new Error("Invalid snapshot name");
      await provider[request.op](request.name, signal); return { [request.op]: request.name };
    case "sleep": await provider.sleep(); return { sleeping: true };
    default: throw new Error("Unsupported computer operation");
  }
}
