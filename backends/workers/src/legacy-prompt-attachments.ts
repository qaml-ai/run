// TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
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
  type LegacyFileRef as FileRef,
} from "./attachment-policy.ts";
import { ApiError, digest } from "./api-contract.ts";
import { volume, type FileBindings, type LegacyVolumeMount as Mount } from "./files.ts";
import { workspaceId } from "./file-mounts.ts";
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
  type AttachedFile as AnyAttachedFile,
} from "./attachment-markers.ts";
export {
  attachmentInput,
  attachmentFiles,
  attachmentMessage,
  type AttachedFile as AnyAttachedFile,
} from "./attachment-markers.ts";
type AttachedFile = AnyAttachedFile & import("./attachment-policy.ts").LegacyFileRef;
type Identity = AttachmentAudioScope & {
  mounts: Mount[];
};
type AttachmentEnv = FileBindings & KeyEnv & MediaBindings;
const pinnedVolumesKey = "file-pin-volumes";

/** Retain only legacy attachment bytes inherited from a stored pilot history. */
// TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
export async function inheritLegacyHistoryPins(env:FileBindings,tenant:string,source:string,target:string,messages:unknown[]) {
  const volumes=new Map<string,Set<string>>();
  for(const message of messages as {content?:unknown}[]) {
    if(!Array.isArray(message.content))continue;
    for(const part of message.content) {
      const file=part?.type==='file'?part as AnyAttachedFile:part?.type==='text'&&typeof part.text==='string'?attachmentMarker(part.text):undefined;
      if(!file||!('key'in file)||!file.key.startsWith(`files/${encodeURIComponent(tenant)}/`))continue;
      const volume=decodeURIComponent(file.key.split('/')[2]??'');
      if(!volume||!await env.VOLUMES.getByName(`${tenant}:${volume}`).hasPin(`agent:${source}`,file.key))continue;
      const keys=volumes.get(volume)??new Set<string>();keys.add(file.key);volumes.set(volume,keys);
    }
  }
  for(const [volume,keys]of volumes)await env.VOLUMES.getByName(`${tenant}:${volume}`).pin(`agent:${target}`,[...keys]);
  return [...volumes.keys()];
}

/** Files are staged once per request; only immutable references are durable. */
export class LegacyPromptAttachments {
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
  async stage(
    identity: Identity,
    inputs: unknown,
  ): Promise<AttachedFile[]> {
    const checked = attachmentInputs(inputs);
    const own = await workspaceId(identity.agent);
    const scratch =
      identity.mounts.find((m) => m.volumeId === own && m.mode === "rw") ??
      identity.mounts.find((m) => m.path === "/workspace" && m.mode === "rw") ??
      identity.mounts.find((m) => m.mode === "rw");
    const files: AttachedFile[] = [];
    for (const input of checked) {
      let path: string;
      if ("path" in input) path = input.path;
      else {
        if (!scratch)
          throw new ApiError(
            400,
            "Attaching files needs a writable mount, like the default /workspace",
          );
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(identity.requestId))
          throw new ApiError(400, "Invalid request id");
        const inside = `/uploads/${identity.requestId}/${input.name}`;
        path = scratch.path + inside;
        const target = normalizePath((scratch.subpath ?? "/") + inside);
        let body: ReadableStream<Uint8Array>,
          contentType = input.contentType;
        if ("url" in input) {
          const { outbound } = await keyServices(this.env);
          const response = await outbound.fetch(input.url, {
            timeoutMs: FILE_LIMITS.urlMs,
            maxBytes: FILE_LIMITS.urlBytes,
            maxRedirects: FILE_LIMITS.urlRedirects,
          });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new ApiError(
              400,
              `Could not fetch ${input.url.origin}${input.url.pathname} (HTTP ${response.status})`,
            );
          }
          body = response.body;
          contentType ??= response.headers.get("content-type") ?? undefined;
        } else {
          const bytes = Buffer.from(input.data, "base64");
          body = new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          });
        }
        // Upload keys use the volume's durable tenant/id metadata. A new private
        // workspace may not have had a file operation yet.
        await volume(this.env, identity.tenant, scratch.volumeId);
        await uploadFile(
          this.env,
          identity.tenant,
          scratch.volumeId,
          target,
          body,
          contentType ?? null,
          undefined,
          "url" in input ? FILE_LIMITS.urlBytes : FILE_LIMITS.inlineBytes,
        );
      }
      const absolute = normalizePath(path);
      const mount = identity.mounts.find((m) =>
        absolute.startsWith(m.path + "/"),
      );
      if (!mount) throw new ApiError(400, `${absolute} is not inside a mount`);
      const inside = normalizePath(
        (mount.subpath ?? "/") + "/" + absolute.slice(mount.path.length),
      );
      const v = await volume(this.env, identity.tenant, mount.volumeId);
      let entry: FileEntry;
      try {
        entry = await v.stat(inside);
      } catch (error) {
        if (/FILE_404|not found|does not exist/i.test(String(error)))
          throw new ApiError(400, `${absolute} does not exist`);
        throw error;
      }
      const hash = entry.sha256 ?? entry.key.split("/").at(-1)!;
      const ref: AttachedFile = {
        type: "file",
        path: absolute,
        volume: mount.volumeId,
        version: entry.version,
        size: entry.size,
        contentType: entry.contentType,
        chunks: [hash],
        key: entry.key,
        ...(input.transcribe === undefined
          ? {}
          : { transcribe: input.transcribe }),
      };
      await this.storage.transaction(async (tx) => {
        const volumes = (await tx.get<string[]>(pinnedVolumesKey)) ?? [];
        await tx.put(pinnedVolumesKey, [
          ...new Set([...volumes, mount.volumeId]),
        ]);
      });
      await v.pin(`agent:${identity.agent}`, [entry.key]);
      if (textual(entry.contentType) && entry.size) {
        const object = await this.env.BUCKET.get(entry.key, {
          range: {
            offset: 0,
            length: Math.min(FILE_LIMITS.headBytes, entry.size),
          },
        });
        if (object)
          ref.head = firstLines(
            Buffer.from(await boundedBytes(object.body, FILE_LIMITS.headBytes)),
            entry.size > FILE_LIMITS.headBytes,
          );
      }
      if (
        /^image\/(png|jpeg|gif|webp)$/.test(entry.contentType) &&
        entry.size <= FILE_LIMITS.imageBytes
      ) {
        const object = await this.env.BUCKET.get(entry.key);
        if (!object) throw new ApiError(503, "Attached image is missing");
        const bytes = Buffer.from(
          await boundedBytes(object.body, FILE_LIMITS.imageBytes),
        );
        const header = imageHeader(bytes);
        if (!header || !imageIntact(bytes, header.mimeType))
          ref.media = { kind: "none", reason: IMAGE_DAMAGED };
        else {
          ref.media = { kind: "image", ...header };
          ref.image =
            bytes.length <= IMAGE_LIMITS.derivativeBytes &&
            Math.max(header.width, header.height) <=
              FILE_LIMITS.requestImageSide
              ? {
                  type: "image_ref",
                  tenant: identity.tenant,
                  key: entry.key,
                  originalKey: entry.key,
                  mimeType: header.mimeType as ImageRef["mimeType"],
                  size: entry.size,
                  version: 1,
                }
              : undefined;
        }
      } else if (entry.contentType === "application/pdf" && entry.size <= FILE_LIMITS.documentBytes) {
        const object = await this.env.BUCKET.get(entry.key);
        if (object) ref.media = await inspectDocument(await boundedBytes(object.body, FILE_LIMITS.documentBytes));
      }
      files.push(ref);
    }
    return transcribeAttachments(this.env, this.storage, identity, files) as Promise<AttachedFile[]>;
  }
}

/** Hydrate file markers only for the provider; images use the existing image seam. */
export function withLegacyAttachmentReferences<A extends Api>(
  provider: Provider<A>,
  env: Pick<FileBindings, "BUCKET" | "IMAGES">,
  getTenant: () => Promise<string>,
  authorizeFile?: (key: string) => Promise<boolean>,
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
        const ref = marker && "key" in marker ? marker : undefined;
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
        const ref = marker && "key" in marker ? marker : undefined;
        if (!ref) {
          content.push(part);
          continue;
        }
        const needsBytes =
          ref.media?.kind === "image" || documents.has(`${m}:${p}`);
        if (
          needsBytes &&
          (!ref.key.startsWith(`files/${encodeURIComponent(tenant)}/`) ||
            !(await authorizeFile?.(ref.key)))
        ) {
          content.push({
            type: "text",
            text: describeFile(
              ref,
              "this agent has no retained attachment reference",
            ),
          });
          continue;
        }
        content.push({
          type: "text",
          text: describeFile(
            ref,
            unseen(ref, model),
          ),
        });
        let image = ref.image;
        if (
          !image &&
          ref.media?.kind === "image" &&
          ref.size <= FILE_LIMITS.imageBytes
        ) {
          image =
            ref.size <= IMAGE_LIMITS.derivativeBytes &&
            Math.max(ref.media.width, ref.media.height) <=
              FILE_LIMITS.requestImageSide
              ? {
                  type: "image_ref",
                  tenant,
                  key: ref.key,
                  originalKey: ref.key,
                  mimeType: ref.media.mimeType as ImageRef["mimeType"],
                  size: ref.size,
                  version: 1,
                }
              : undefined;
          if (!image) {
            const object = await env.BUCKET.get(ref.key);
            if (object) {
              try { image = await storeImage(
                env,
                tenant,
                await boundedBytes(object.body, FILE_LIMITS.imageBytes),
              ); } catch {
                content.push({ type: "text", text: `[image omitted: ${ref.media.width}×${ref.media.height} px, could not be resized]` });
              }
            }
          }
        }
        if (image && model.input.includes("image"))
          content.push(
            ...(imageReferenceInput("", [image], tenant) as any[]).slice(1),
          );
        else if (documents.has(`${m}:${p}`)) {
          const object = await env.BUCKET.get(ref.key);
          if (!object) throw new ApiError(503, "Attached document is missing");
          content.push({
            type: "image",
            mimeType: "application/pdf",
            data: Buffer.from(
              await boundedBytes(object.body, FILE_LIMITS.documentBytes),
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
