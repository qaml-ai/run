import { createHash } from "node:crypto";
import { HttpError } from "../http.ts";
import type { FileLinks } from "../files.ts";
import { resolve, writable, type ToolContext } from "../volume-tools.ts";
import { VOLUME_LIMITS, type FileEntry, type VolumeService } from "../volumes.ts";
import type { ComputerDriver, Reference } from "./providers.ts";

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const failure = (status: number) => new HttpError(status, status === 507 ? "Workspace storage limit reached" : status === 413 ? "Computer transfer exceeds the file size limit" : "Computer transfer failed");

export class ComputerTransfers {
  readonly options: { volumes: VolumeService; links: FileLinks };
  constructor(options: ComputerTransfers["options"]) { this.options = options; }

  async run(context: ToolContext, upload: boolean, args: Record<string, any>, driver: Pick<ComputerDriver, "call">, ref: Reference, seconds: number, requestKey: string) {
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
    const { volumes, links } = this.options;
    const source: FileEntry & { type?: string } | undefined = upload ? await volumes.call(target.mount.volumeId, context.tenant, "stat", { path: target.path }) : undefined;
    if (source && source.type !== "file") throw new HttpError(400, "Transfer source must be a file");
    if (source && source.size > VOLUME_LIMITS.fileBytes) throw failure(413);
    const { url } = links.sign({ tenant: context.tenant, agent: context.agent, volume: target.mount.volumeId, path: target.path,
      method: upload ? "GET" : "PUT", maxBytes: VOLUME_LIMITS.fileBytes, expiresIn: 120 });
    // A relative name starting with '-' must remain a filename, including for curl's upload option.
    const path = quote(remote.startsWith("-") ? `./${remote}` : remote);
    const curl = `curl -q --globoff --fail --silent --show-error --connect-timeout ${Math.min(15, seconds)} --max-time ${seconds} --max-filesize ${VOLUME_LIMITS.fileBytes} --write-out '%{http_code}'`;
    const transfer = upload
      ? `mkdir -p -- "$(dirname -- ${path})" && status=$(${curl} --output ${path} -- ${quote(url)})`
      : `[ -e ${path} ] || { printf 'CAMEL_MISSING\\n'; exit 1; }; n=$(wc -c < ${path}) || exit 1; [ "$n" -le ${VOLUME_LIMITS.fileBytes} ] || { printf 'CAMEL_TRANSFER 413\\n'; exit 1; }; status=$(${curl} --upload-file ${path} --output /dev/null -- ${quote(url)})`;
    const command = `${transfer}; code=$?; printf 'CAMEL_TRANSFER %s\\n' "$status"; [ "$code" -eq 0 ] || exit "$code"; n=$(wc -c < ${path}) && h=$(sha256sum < ${path}) && printf 'CAMEL_FILE %s %s\\n' "$n" "\${h%% *}"`;
    // Only the fixed receipt is read; provider errors can repeat the URL or command.
    let value: any;
    try { value = await driver.call(ref, "computer_exec", { command, timeoutSeconds: seconds, remainingSeconds: seconds, requestKey }); }
    catch { throw failure(502); }
    const output = typeof value?.stdout === "string" ? value.stdout : "";
    if (!upload && /^CAMEL_MISSING$/m.test(output)) throw new HttpError(404, `${remote} not found on the computer`);
    const status = /^CAMEL_TRANSFER (\d{3})$/m.exec(output);
    if (status && [413, 507].includes(Number(status[1]))) throw failure(Number(status[1]));
    const receipt = /^CAMEL_FILE\s+(\d+) ([a-f0-9]{64})$/m.exec(output);
    if (value?.exitCode !== 0 || !status || Number(status[1]) < 200 || Number(status[1]) >= 300 || !receipt) throw failure(502);
    const entry: FileEntry = source ?? await volumes.call(target.mount.volumeId, context.tenant, "stat", { path: target.path });
    const hash = createHash("sha256");
    for await (const chunk of volumes.stream(context.tenant, entry)) hash.update(chunk);
    const sha256 = hash.digest("hex");
    if (entry.size !== Number(receipt[1]) || sha256 !== receipt[2]) throw failure(502);
    if (!upload) context.onWrite?.({ path: target.show(target.path), size: entry.size, version: entry.version, contentType: entry.contentType! });
    return { path: upload ? remote : target.show(target.path), size: entry.size, sha256 };
  }
}
