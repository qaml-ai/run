import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileStorage, type Storage } from "../shared/storage.ts";
import { openStorage, storageFromEnvironment } from "../shared/storage-config.ts";

/**
 * Copy a single-host data directory (file storage) into another backend, such as
 * S3. Documents are overwritten, logs are replaced whole and blobs (volume chunks)
 * are immutable, so re-running after a partial copy is safe. Stop the runtime
 * first: this is a cold copy.
 *
 *   AGENT_STORAGE=s3 AGENT_S3_BUCKET=... node src/migrate-storage.ts /data
 */
export async function copyStorage(root: string, target: Storage) {
  const source = fileStorage(root);
  const files: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(directory, entry.name));
      else files.push(relative(root, join(directory, entry.name)).split(sep).join("/"));
    }
  };
  await walk(root);
  let documents = 0, logs = 0, records = 0, blobs = 0;
  for (const file of files.sort()) {
    if (file.endsWith(".json")) {
      const key = file.slice(0, -".json".length);
      const stored = await source.readJson(key);
      if (!stored) continue;
      await target.writeJson(key, stored.value);
      documents++;
    } else if (file.endsWith(".jsonl")) {
      const key = file.slice(0, -".jsonl".length);
      const entries = await source.log(key).read();
      await target.log(key).rewrite(() => entries);
      logs++; records += entries.length;
    } else if (file.endsWith(".bin")) {
      const key = file.slice(0, -".bin".length);
      await target.writeBlob(key, (await source.readBlob(key))!);
      blobs++;
    }
  }
  return { documents, logs, records, blobs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(process.argv[2] ?? process.env.AGENT_DATA_DIR ?? ".agent-runtime");
  const descriptor = storageFromEnvironment(root);
  if (descriptor.kind === "file" && !descriptor.shared) throw new Error("Set AGENT_STORAGE to the destination backend (s3 or shared-file)");
  console.log(JSON.stringify({ type: "migrated", from: root, to: descriptor.kind, ...await copyStorage(root, await openStorage(descriptor)) }));
}
