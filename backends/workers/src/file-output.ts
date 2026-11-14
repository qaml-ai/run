import { FILE_LIMITS } from "../../../src/limits.ts";
import type { FileBindings } from "./files.ts";
import type { PresentedRepoFile, WrittenRepoFile } from "./repos/agent-files.ts";
import { repoContext, type RepoEnv } from "./repos/registry.ts";
import { signRepoLink } from "./repos/links.ts";
import { signFile } from "./images.ts";
import { downloadHeaders, safeName } from "./file-policy.ts";

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
  path: string,
  emit: (event: unknown) => Promise<void>,
  bytes?: Uint8Array,
) {
  const origin = env.PUBLIC_BASE_URL ?? identity.origin;
  // A VM version can disappear at idle stop. Keep the presented bytes under the
  // tenant's signed-file prefix so the download does not depend on the branch.
  const vmLink = bytes && origin && env.FILE_SIGNING_SECRET
    ? await (async () => {
      const name = safeName(file.path);
      const key = `files/${encodeURIComponent(identity.tenant)}/presented/${file.blob}/${encodeURIComponent(name)}`;
      const headers = downloadHeaders(file.contentType, name);
      const link = await signFile(env, identity.tenant, key, origin);
      await env.BUCKET.put(key, bytes, {
        httpMetadata: { contentType: headers["Content-Type"], contentDisposition: headers["Content-Disposition"] },
      });
      return link;
    })()
    : undefined;
  const added = await storage.transaction(async tx => {
    const outputs = await tx.get<Outputs>(outputKey(identity.requestId)) ?? { files: [], presented: [] };
    if (outputs.presented.some(item => item.callId === identity.callId)) return false;
    if (outputs.presented.length >= FILE_LIMITS.attachments)
      throw new Error(`At most ${FILE_LIMITS.attachments} files can be presented in a run`);
    outputs.presented.push({ callId: identity.callId, file });
    await tx.put(outputKey(identity.requestId), outputs);
    return true;
  });
  if (!added) return;
  const link = bytes ? vmLink : origin && env.FILE_SIGNING_SECRET
    ? await signRepoLink(await repoContext(env as RepoEnv, identity.tenant, file.repo), origin, { path: file.repoPath ?? path.replace(/^\/+/, ""), version: file.version as string })
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
