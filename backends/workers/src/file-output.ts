import { FILE_LIMITS } from "../../../src/limits.ts";
import type { FileBindings, PresentedVolumeFile, WrittenVolumeFile } from "./files.ts";
import { signVolumeLink } from "./file-links.ts";

type Outputs = {
  files: WrittenVolumeFile[];
  presented: { callId: string; file: PresentedVolumeFile }[];
};
const outputKey = (requestId: string) => `file-output:${requestId}`;
const pinnedVolumesKey = "file-pin-volumes";

export async function writtenFile(storage: DurableObjectStorage, requestId: string, file: WrittenVolumeFile) {
  await storage.transaction(async tx => {
    const outputs = await tx.get<Outputs>(outputKey(requestId)) ?? { files: [], presented: [] };
    const index = outputs.files.findIndex(item => item.path === file.path);
    if (index >= 0) outputs.files[index] = file;
    else if (outputs.files.length < 100) outputs.files.push(file);
    await tx.put(outputKey(requestId), outputs);
  });
}

export async function presentedFile(
  storage: DurableObjectStorage,
  env: FileBindings,
  identity: { requestId: string; callId: string; tenant: string; origin?: string },
  file: PresentedVolumeFile,
  volumePath: string,
  emit: (event: unknown) => Promise<void>,
) {
  const added = await storage.transaction(async tx => {
    const outputs = await tx.get<Outputs>(outputKey(identity.requestId)) ?? { files: [], presented: [] };
    if (outputs.presented.some(item => item.callId === identity.callId)) return false;
    if (outputs.presented.length >= FILE_LIMITS.attachments)
      throw new Error(`At most ${FILE_LIMITS.attachments} files can be presented in a run`);
    outputs.presented.push({ callId: identity.callId, file });
    const volumes = await tx.get<string[]>(pinnedVolumesKey) ?? [];
    await tx.put({
      [outputKey(identity.requestId)]: outputs,
      [pinnedVolumesKey]: [...new Set([...volumes, file.volume])],
    });
    return true;
  });
  if (!added) return;
  const origin = env.PUBLIC_BASE_URL ?? identity.origin;
  const link = origin && env.FILE_SIGNING_SECRET
    ? signVolumeLink(env, origin, identity.tenant, file.volume, { path: volumePath })
    : undefined;
  await emit({
    type: "event", requestId: identity.requestId,
    event: { type: "file_presented", file, ...(link ? { url: link.url, expiresAt: link.expiresAt } : {}) },
  });
}

export async function fileOutputs(storage: DurableObjectStorage, requestId: string) {
  const outputs = await storage.get<Outputs>(outputKey(requestId));
  return {
    ...(outputs?.files.length ? { files: outputs.files } : {}),
    ...(outputs?.presented.length ? { presented: outputs.presented.map(item => item.file) } : {}),
  };
}

/** Pins belong to the agent's retained outputs, even after a volume is unmounted. */
export async function releasePresentedFiles(storage: DurableObjectStorage, env: FileBindings, tenant: string, agent: string) {
  for (const volume of await storage.get<string[]>(pinnedVolumesKey) ?? [])
    await env.VOLUMES.getByName(`${tenant}:${volume}`).unpin(`agent:${agent}`);
  await storage.delete(pinnedVolumesKey);
}
