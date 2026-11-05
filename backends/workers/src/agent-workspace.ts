import type { FileBindings } from "./files.ts";

/** Fork the private workspace from an immutable read set. Shared mounts stay shared. */
export async function copyAgentWorkspace(env: FileBindings, tenant: string, sourceId: string, targetId: string) {
  const source = env.VOLUMES.getByName(`${tenant}:agent:${sourceId}`);
  const target = env.VOLUMES.getByName(`${tenant}:agent:${targetId}`);
  await source.initialize(tenant, `agent:${sourceId}`, "Private agent files");
  await target.initialize(tenant, `agent:${targetId}`, "Private agent files");
  const snapshot = await source.readSet();
  for (const file of snapshot.files) {
    // The read-set's R2 keys are immutable, so concurrent source edits cannot
    // mix newer contents into the fork. Copy one bounded file at a time.
    const object = await env.BUCKET.get(file.key);
    if (!object) throw new Error("Fork source file is missing");
    await target.write(file.path, new Uint8Array(await object.arrayBuffer()), file.contentType);
  }
}
