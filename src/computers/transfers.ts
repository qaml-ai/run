import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db.ts";
import { HttpError } from "../http.ts";
import { resolve, writable, type ToolContext } from "../volume-tools.ts";
import { VOLUME_LIMITS, type FileEntry, type VolumeService } from "../volumes.ts";
import type { ComputerDriver, Reference } from "./providers.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const failure = (status: number) => new HttpError(status, status === 507 ? "Workspace storage limit reached" : status === 413 ? "Computer transfer exceeds the file size limit" : "Computer transfer failed");
export const TRANSFER_PATH = "/v1/computer-transfers";

export class ComputerTransfers {
  readonly options: { db: Db; volumes: VolumeService; publicUrl: () => string; now?: () => number };
  constructor(options: ComputerTransfers["options"]) { this.options = options; }
  private now() { return this.options.now?.() ?? Date.now(); }

  async run(context: ToolContext, upload: boolean, args: Record<string, any>, driver: ComputerDriver, ref: Reference, seconds: number, requestKey: string) {
    const remote = upload ? args.to : args.from, local = upload ? args.from : args.to;
    if (typeof remote !== "string" || !remote || remote.includes("\0") || typeof local !== "string" || !local || local.includes("\0")) throw new HttpError(400, "Invalid transfer path");
    let target;
    try {
      target = resolve(context.mounts, local);
      if (!target) throw new Error("Name a path inside a mount");
    } catch (error) { throw new HttpError(400, (error as Error).message); }
    if (!upload) {
      try { writable(target); } catch (error) { throw new HttpError(403, (error as Error).message); }
    }
    const { volumes, db } = this.options;
    const entry: FileEntry & { type?: string } | undefined = upload ? await volumes.call(target.mount.volumeId, context.tenant, "stat", { path: target.path }) : undefined;
    if (entry && entry.type !== "file") throw new HttpError(400, "Transfer source must be a file");
    if (entry && entry.size > VOLUME_LIMITS.fileBytes) throw failure(413);
    const token = randomBytes(32).toString("hex"), key = hash(token);
    await db.query("insert into computer_transfers(token_hash,tenant,agent,volume,path,method,max_bytes,expires_at,entry) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [key, context.tenant, context.agent, target.mount.volumeId, target.path, upload ? "GET" : "PUT", VOLUME_LIMITS.fileBytes, this.now() + Math.min(300, seconds) * 1000, entry ? JSON.stringify(entry) : null]);
    try {
      const url = `${this.options.publicUrl()}${TRANSFER_PATH}?token=${token}`;
      // A relative name starting with '-' must remain a filename, including for curl's upload option.
      const path = quote(remote.startsWith("-") ? `./${remote}` : remote);
      const curl = `curl -q --globoff --fail --silent --show-error --connect-timeout ${Math.min(15, seconds)} --max-time ${seconds} --max-filesize ${VOLUME_LIMITS.fileBytes}`;
      const command = upload
        ? `mkdir -p -- "$(dirname -- ${path})" && ${curl} --output ${path} -- ${quote(url)}`
        : `n=$(wc -c < ${path}) && [ "$n" -le ${VOLUME_LIMITS.fileBytes} ] && ${curl} --upload-file ${path} --output /dev/null -- ${quote(url)}`;
      // Never return or log provider output: even a shell error can repeat the command or URL.
      let value: any;
      try { value = await driver.call(ref, "computer_exec", { command, timeoutSeconds: seconds, remainingSeconds: seconds, requestKey }); }
      catch { throw failure(502); }
      const receipt = (await db.query("select result,status from computer_transfers where token_hash=$1", [key])).rows[0];
      if (receipt?.status && receipt.status !== 200) throw failure(receipt.status);
      if (value?.exitCode !== 0 || !receipt?.result) throw failure(502);
      const result = receipt.result;
      if (!upload) context.onWrite?.({ path: target.show(target.path), size: result.size, version: result.version, contentType: result.contentType });
      return { path: upload ? remote : target.show(target.path), size: result.size, sha256: result.sha256 };
    } finally { await db.query("delete from computer_transfers where token_hash=$1", [key]); }
  }

  async serve(request: Request): Promise<Response> {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(403, "Invalid transfer");
    const key = hash(token), { db, volumes } = this.options;
    const grant = (await db.query(`update computer_transfers t set claimed_at=$3 where token_hash=$1 and method=$2 and claimed_at is null and expires_at>$3
      and exists(select 1 from agents a where a.tenant=t.tenant and a.id=t.agent and not a.revoked and a.purged_at is null and (a.expires_at is null or a.expires_at>$3)) returning t.*`, [key, request.method, this.now()])).rows[0];
    if (!grant) throw new HttpError(403, "Invalid, expired or used transfer");
    const finish = (status: number, result?: unknown) => db.query("update computer_transfers set status=$2,result=$3 where token_hash=$1", [key, status, result ? JSON.stringify(result) : null]);
    const digest = createHash("sha256");
    try {
      if (!await volumes.owns(grant.volume, grant.tenant)) throw failure(404);
      if (request.method === "GET") {
        const entry: FileEntry = grant.entry;
        if (entry.size > grant.max_bytes) throw failure(413);
        const headers = { "Content-Type": "application/octet-stream", "Content-Length": String(entry.size), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
        if (!entry.size) {
          await finish(200, { size: 0, sha256: digest.digest("hex") });
          return new Response(null, { headers });
        }
        const source = volumes.stream(grant.tenant, entry);
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await source.next();
              if (next.done) { await finish(200, { size: entry.size, sha256: digest.digest("hex") }); controller.close(); }
              else {
                digest.update(next.value);
                sent += next.value.byteLength;
                if (sent === entry.size) await finish(200, { size: sent, sha256: digest.digest("hex") });
                controller.enqueue(next.value);
                if (sent === entry.size) { controller.close(); await source.return(undefined); }
              }
            } catch { await finish(502); controller.error(failure(502)); }
          },
          async cancel() { await source.return(undefined); await finish(502); },
        });
        return new Response(body, { headers });
      }
      if (Number(request.headers.get("content-length") ?? 0) > grant.max_bytes) throw failure(413);
      const reader = request.body?.getReader();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; void reader?.cancel().catch(() => {}); }, Math.max(1, grant.expires_at - this.now()));
      timeout.unref();
      const source = async function* () {
        try {
          while (reader) {
            const next = await reader.read();
            if (timedOut) throw failure(408);
            if (next.done) break;
            digest.update(next.value);
            yield next.value;
          }
        } finally { await reader?.cancel(); }
      };
      let entry;
      try { entry = await volumes.put(grant.tenant, grant.volume, grant.path, source(), { limit: grant.max_bytes, by: grant.agent }); }
      finally { clearTimeout(timeout); }
      await finish(200, { size: entry.size, sha256: digest.digest("hex"), version: entry.version, contentType: entry.contentType });
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      await finish(status);
      throw failure(status);
    }
  }

  async sweep() { await this.options.db.query("delete from computer_transfers where expires_at<=$1", [this.now()]); }
}
