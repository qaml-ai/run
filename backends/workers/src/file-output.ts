import { signVolumeLink } from "./file-links.ts";
import { FILE_LIMITS } from "../../../src/limits.ts";
import type { FileBindings } from "./files.ts";
import type { PresentedRepoFile, WrittenRepoFile } from "./repos/agent-files.ts";
import { repoContext, type RepoEnv } from "./repos/registry.ts";
import { signRepoLink } from "./repos/links.ts";

type Outputs = {
  files: WrittenRepoFile[];
  presented: { callId: string; file: PresentedRepoFile }[];
};
const outputKey = (requestId: string) => `file-output:${requestId}`;


export async function writtenFile(storage: DurableObjectStorage, requestId: string, file: WrittenRepoFile) {
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
  file: PresentedRepoFile,
  volumePath: string,
  emit: (event: unknown) => Promise<void>,
) {
  const added = await storage.transaction(async tx => {
    const outputs = await tx.get<Outputs>(outputKey(identity.requestId)) ?? { files: [], presented: [] };
    if (outputs.presented.some(item => item.callId === identity.callId)) return false;
    if (outputs.presented.length >= FILE_LIMITS.attachments)
      throw new Error(`At most ${FILE_LIMITS.attachments} files can be presented in a run`);
    outputs.presented.push({ callId: identity.callId, file });
    await tx.put(outputKey(identity.requestId), outputs);
    // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
    if ('volume' in file) await tx.put('file-pin-volumes',[...new Set([...(await tx.get<string[]>('file-pin-volumes')??[]),file.volume])]);
    return true;
  });
  if (!added) return;
  const origin = env.PUBLIC_BASE_URL ?? identity.origin;
  const link = origin && env.FILE_SIGNING_SECRET
    ? "volume" in file ? signVolumeLink(env,origin,identity.tenant,file.volume,{path:volumePath}) : await signRepoLink(await repoContext(env as RepoEnv, identity.tenant, file.repo), origin, { path: file.repoPath ?? volumePath.replace(/^\/+/, ""), version: file.version as string })
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


// TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
export async function releaseLegacyPresentedFiles(storage:DurableObjectStorage,env:FileBindings,tenant:string,agent:string) {
  for(const volume of await storage.get<string[]>('file-pin-volumes')??[])await env.VOLUMES.getByName(`${tenant}:${volume}`).unpin(`agent:${agent}`);
  await storage.delete('file-pin-volumes');
}
