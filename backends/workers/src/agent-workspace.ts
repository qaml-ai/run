import type { AgentConfiguration } from "./api-contract.ts";
import { workspaceId } from "./file-mounts.ts";
import { uploadFile } from "./file-upload.ts";
import type { FileBindings } from "./files.ts";

/** Resolved mounts retain their paths and permissions, with a new private volume. */
export async function forkWorkspaceMounts(
  mounts: AgentConfiguration["mounts"],
  sourceId: string,
  targetId: string,
) {
  const source = await workspaceId(sourceId), target = await workspaceId(targetId);
  const given = mounts ?? [{ volumeId: source, path: "/workspace", mode: "rw" as const }];
  const privateMounts = given.filter(mount => mount.volumeId === source);
  const copied = given.map(mount => {
    if (mount.volumeId !== source) return { ...mount };
    // Reuse the marker where it describes the exact mount. It also avoids an
    // extra marker taking a slot when the source already has sixteen mounts.
    if (privateMounts.length === 1 && mount.mode === "rw" && !mount.subpath && !mount.notify)
      return { workspace: true, path: mount.path };
    return { ...mount, volumeId: target };
  });
  // A source may have no workspace, or have it mounted somewhere else. Do not
  // let mount preparation silently add a default /workspace to the fork.
  if (!copied.some(mount => mount.path === "/workspace" || mount.workspace !== undefined)) copied.push({ workspace: false });
  return { mounts: copied, copyPrivate: privateMounts.length > 0 };
}

/** Fork the private workspace from an immutable read set. Shared mounts stay shared. */
export async function copyAgentWorkspace(env: FileBindings, tenant: string, sourceId: string, targetId: string) {
  const sourceVolume = await workspaceId(sourceId), targetVolume = await workspaceId(targetId);
  const source = env.VOLUMES.getByName(`${tenant}:${sourceVolume}`);
  const target = env.VOLUMES.getByName(`${tenant}:${targetVolume}`);
  await source.initialize(tenant, sourceVolume, "workspace");
  await target.initialize(tenant, targetVolume, "workspace");
  const snapshot = await source.readSet();
  const pin = `fork:${targetId}:${crypto.randomUUID()}`;
  await source.pin(pin, snapshot.files.map(file => file.key), Date.now() + 86400_000);
  try {
    for (const file of snapshot.files) {
      // Immutable keys and a temporary pin retain the exact read set during
      // concurrent edits/collection. Upload streams with a bounded part buffer.
      const object = await env.BUCKET.get(file.key);
      if (!object) throw new Error("Fork source file is missing");
      await uploadFile(env, tenant, targetVolume, file.path, object.body, file.contentType);
    }
  } finally {
    await source.unpin(pin);
  }
}
