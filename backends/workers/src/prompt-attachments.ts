import { Buffer } from "node:buffer";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type TranscriptContext,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { FILE_LIMITS } from "../../../src/limits.ts";
import {
  imageHeader,
  imageIntact,
  IMAGE_DAMAGED,
} from "../../../src/image-header.ts";
import {
  attachmentInputs,
  describeFile,
  documentPayload,
  firstLines,
  nativeBlock,
  unseen,
  textual,
  type RepoFileRef as FileRef,
} from "./attachment-policy.ts";
import { ApiError, digest } from "./api-contract.ts";
import type { FileBindings, Mount } from "./files.ts";
import { agentStore } from "./repos/agent-store.ts";
import { agentRepoId } from "./repos/mounts.ts";
import { readAttachment } from "./repos/attachments.ts";
import type { RepoEnv } from "./repos/registry.ts";
import type { WriteInput } from "./repos/write.ts";

import { uploadFile } from "./file-upload.ts";
import { normalizePath, type FileEntry } from "./volume.ts";
import {
  boundedBytes,
  imageReferenceInput,
  IMAGE_LIMITS,
  storeImage,
  type ImageRef,
} from "./images.ts";
import { keyServices, type KeyEnv } from "./security-services.ts";
import {
  transcribeAttachments,
  type AttachmentAudioScope,
} from "./attachment-transcription.ts";
import type { MediaBindings } from "./media-api.ts";
import { inspectDocument } from "./document-inspection.ts";

import {
  ATTACHMENT_MARKER as MARKER,
  attachmentMarker,
  type AttachedFile,
} from "./attachment-markers.ts";
export {
  attachmentInput,
  attachmentFiles,
  attachmentMessage,
  type AttachedFile,
} from "./attachment-markers.ts";
type Identity = AttachmentAudioScope & {
  mounts: import("./repos/mounts.ts").Mount[];
};
type AttachmentEnv = FileBindings & KeyEnv & MediaBindings;


/** Files are staged once per request; only immutable references are durable. */
export class PromptAttachments {
  private pending = new Map<
    string,
    { fingerprint: string; files: Promise<AttachedFile[]> }
  >();
  private storage: DurableObjectStorage;
  private env: AttachmentEnv;
  constructor(storage: DurableObjectStorage, env: AttachmentEnv) {
    this.storage = storage;
    this.env = env;
  }
  async reference(identity: Identity, path: string): Promise<AttachedFile> {
    return (await this.stage(identity, [{ path }]))[0];
  }
  async attach(identity: Identity, inputs: unknown): Promise<AttachedFile[]> {
    const fingerprint = await digest(JSON.stringify(inputs));
    const key = `prompt-attachments:${identity.requestId}`;
    const prior = await this.storage.get<{
      fingerprint: string;
      files: AttachedFile[];
    }>(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "Request ID reused with different files",
          "IDEMPOTENCY_CONFLICT",
        );
      return prior.files;
    }
    const pending = this.pending.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "Request ID reused with different files",
          "IDEMPOTENCY_CONFLICT",
        );
      return pending.files;
    }
    const files = this.stage(identity, inputs).then(async (files) => {
      await this.storage.put(key, { fingerprint, files });
      return files;
    });
    this.pending.set(key, { fingerprint, files });
    try {
      return await files;
    } finally {
      this.pending.delete(key);
    }
  }
  private async stage(
    identity: Identity,
    inputs: unknown,
  ): Promise<AttachedFile[]> {
    return this.stageRepos(identity, inputs);
  }
  private async stageRepos(identity:Identity,inputs:unknown):Promise<AttachedFile[]> {
    const checked=attachmentInputs(inputs);
    const repoMounts=identity.mounts.filter((m):m is Mount=>"repo" in m);

    const own = agentRepoId(identity.tenant, identity.agent);
    const scratch =
      repoMounts.find((m) => m.repo === own && m.mode === "rw") ??
      repoMounts.find((m) => m.path === "/workspace" && m.mode === "rw") ??
      repoMounts.find((m) => m.mode === "rw");
    const files: AttachedFile[] = [];
    const changes: WriteInput['changes'] = {};
    const paths: string[] = [];
    for (const input of checked) {
      if ("path" in input) { paths.push(input.path); continue; }
      if (!scratch) throw new ApiError(400, "Attaching files needs a writable mount, like the default /workspace");
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(identity.requestId)) throw new ApiError(400,"Invalid request id");
      const inside = `/uploads/${identity.requestId}/${input.name}`;
      paths.push(scratch.path + inside);
      let bytes: Uint8Array;
      if ("url" in input) {
        const { outbound } = await keyServices(this.env);
        const response = await outbound.fetch(input.url, {timeoutMs: FILE_LIMITS.urlMs,maxBytes:FILE_LIMITS.urlBytes,maxRedirects:FILE_LIMITS.urlRedirects});
        if (!response.ok) throw new ApiError(400,`Could not fetch attachment (HTTP ${response.status})`);
        bytes=await boundedBytes(response.body,FILE_LIMITS.urlBytes);
      } else bytes=Buffer.from(input.data,"base64");
      changes[normalizePath((scratch.subpath??"/")+inside).slice(1)]={bytes};
    }
    let savedVersion:string|undefined;
    if (Object.keys(changes).length && scratch) {
      const store=await agentStore(this.env as RepoEnv,identity.tenant,scratch.repo,scratch.ref??"main",identity.agent);
      savedVersion=(await store.commit(changes,{},`attachments ${identity.requestId}`,{'Camel-Run':identity.requestId})).version??undefined;
    }
    for (const [index,input] of checked.entries()) {
      const path=paths[index];
      const absolute = normalizePath(path);
      const mount = repoMounts.find((m) =>
        absolute.startsWith(m.path + "/"),
      );
      if (!mount) throw new ApiError(400, `${absolute} is not inside a mount`);
      const inside = normalizePath(
        (mount.subpath ?? "/") + "/" + absolute.slice(mount.path.length),
      );
      const v = await agentStore(this.env as RepoEnv, identity.tenant, mount.repo, mount.ref??"main",identity.agent);
      const entry=await v.stat(inside,"path"in input?undefined:savedVersion);
      const ref: AttachedFile & import("./attachment-policy.ts").RepoFileRef = {
        type:"file",path:absolute,repo:mount.repo,repoPath:inside.slice(1),version:entry.version,
        blob:entry.blob,size:entry.size,contentType:entry.contentType,
        ...(input.transcribe===undefined?{}:{transcribe:input.transcribe}),
      };
      if (textual(entry.contentType) && entry.size) {
        const bytes=await readAttachment(this.env as RepoEnv,identity.tenant,ref,`bytes=0-${Math.min(FILE_LIMITS.headBytes,entry.size)-1}`);
        ref.head=firstLines(Buffer.from(bytes),entry.size>FILE_LIMITS.headBytes);
      }
      if (/^image\/(png|jpeg|gif|webp)$/.test(entry.contentType) && entry.size<=FILE_LIMITS.imageBytes) {
        const bytes=Buffer.from(await readAttachment(this.env as RepoEnv,identity.tenant,ref)),header=imageHeader(bytes);
        ref.media=!header||!imageIntact(bytes,header.mimeType)?{kind:"none",reason:IMAGE_DAMAGED}:{kind:"image",...header};
      } else if(entry.contentType==="application/pdf"&&entry.size<=FILE_LIMITS.documentBytes) ref.media=await inspectDocument(await readAttachment(this.env as RepoEnv,identity.tenant,ref));
      files.push(ref);
    }
    return transcribeAttachments(this.env, this.storage, identity, files);
  }
}

/** Hydrate file markers only for the provider; images use the existing image seam. */
export function withAttachmentReferences<A extends Api>(
  provider: Provider<A>,
  env: FileBindings & RepoEnv,
  getTenant: () => Promise<string>,
  authorizeFile?: (key: string) => Promise<boolean>,
  authorizeRepoFile?: (file:FileRef)=>Promise<boolean>,
): Provider<A> {
  const hydrate = async (model: Model<A>, context: TranscriptContext) => {
    const tenant = await getTenant();
    let documentBytes = 0;
    const documents = new Set<string>();
    for (let m = context.messages.length - 1; m >= 0; m--) {
      const message = context.messages[m];
      if (!Array.isArray(message.content)) continue;
      for (let p = message.content.length - 1; p >= 0; p--) {
        const part = message.content[p];
        if (part.type !== "text" || !part.text.startsWith(MARKER)) continue;
        const marker = attachmentMarker(part.text);
        const ref = marker && "repo" in marker ? marker : undefined;
        if (!ref) continue;
        if (
          nativeBlock(ref, model) === "document" &&
          documentBytes + ref.size <= FILE_LIMITS.requestFileBytes
        ) {
          documents.add(`${m}:${p}`);
          documentBytes += ref.size;
        }
      }
    }
    const messages = [];
    for (const [m, message] of context.messages.entries()) {
      if (!Array.isArray(message.content)) {
        messages.push(message);
        continue;
      }
      const content = [];
      for (const [p, part] of message.content.entries()) {
        if (part.type !== "text" || !part.text.startsWith(MARKER)) {
          content.push(part);
          continue;
        }
        const marker = attachmentMarker(part.text);
        const ref = marker && "repo" in marker ? marker : undefined;
        if (!ref) {
          content.push(part);
          continue;
        }
        const needsBytes =
          ref.media?.kind === "image" || documents.has(`${m}:${p}`);
        if(needsBytes && !await authorizeRepoFile?.(ref)) {
          content.push({type:'text',text:describeFile(ref,'this agent has no retained attachment reference')});
          continue;
        }
        content.push({
          type: "text",
          text: describeFile(
            ref,
            unseen(ref, model),
          ),
        });
        if (nativeBlock(ref,model) === "image" && ref.media?.kind === "image") {
          const bytes=await readAttachment(env,tenant,ref);
          content.push({type:"image",mimeType:ref.media.mimeType,data:Buffer.from(bytes).toString('base64')});
        }
        else if (documents.has(`${m}:${p}`)) {
          const bytes = await readAttachment(env,tenant,ref);
          content.push({
            type: "image",
            mimeType: "application/pdf",
            data: Buffer.from(
              bytes,
            ).toString("base64"),
          });
        }
      }
      messages.push({ ...message, content });
    }
    return { ...context, messages } as TranscriptContext;
  };
  const wrap =
    (simple: boolean) =>
    (model: Model<A>, context: TranscriptContext, options?: any) => {
      const output = createAssistantMessageEventStream();
      void (async () => {
        try {
          const prepared = await hydrate(model, context);
          const before = options?.onPayload;
          const next = {
            ...options,
            onPayload: async (payload: unknown, model: Model<A>) => {
              const converted = documentPayload(payload);
              return (await before?.(converted, model)) ?? converted;
            },
          };
          const source = simple
            ? provider.streamSimple(model, prepared, next)
            : provider.stream(model, prepared, next);
          for await (const event of source) output.push(event);
          output.end(await source.result());
        } catch (error) {
          const message: AssistantMessage = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            stopReason: "error",
            timestamp: Date.now(),
            errorMessage:
              error instanceof Error
                ? error.message
                : "Attachment hydration failed",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          };
          output.push({ type: "error", reason: "error", error: message });
        }
      })();
      return output;
    };
  return { ...provider, stream: wrap(false), streamSimple: wrap(true) };
}
