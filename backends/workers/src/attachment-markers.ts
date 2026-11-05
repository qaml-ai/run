import type { UserMessage } from "@earendil-works/pi-ai";
import { validFileRef, type FileRef } from "./attachment-policy.ts";
import type { ImageRef } from "./images.ts";
export const ATTACHMENT_MARKER = "[camelrun-file-ref:v1]";
export type AttachedFile = FileRef & {
  key: string;
  image?: ImageRef;
  transcribe?: boolean;
};
const publicFile = ({ image: _image, ...file }: AttachedFile) => file;
export function attachmentMarker(text: string): AttachedFile | undefined {
  if (!text.startsWith(ATTACHMENT_MARKER)) return;
  try {
    const file = JSON.parse(text.slice(ATTACHMENT_MARKER.length));
    if (validFileRef(file) && typeof (file as AttachedFile).key === "string")
      return file as AttachedFile;
  } catch {
    /* Ordinary user text may begin with a marker prefix. */
  }
}
export function attachmentMessage<T>(message: T): T {
  if (!message || typeof message !== "object") return message;
  const value = message as { content?: unknown };
  if (!Array.isArray(value.content)) return message;
  return {
    ...message,
    content: value.content.map((part) => {
      if (
        part?.type !== "text" ||
        typeof part.text !== "string" ||
        !part.text.startsWith(ATTACHMENT_MARKER)
      )
        return part;
      const file = attachmentMarker(part.text);
      return file ? publicFile(file) : part;
    }),
  };
}
export function attachmentInput(
  text: string,
  files: AttachedFile[],
): UserMessage["content"] {
  return [
    { type: "text", text },
    ...files.map((file) => ({
      type: "text" as const,
      text: ATTACHMENT_MARKER + JSON.stringify(file),
    })),
  ];
}
export const attachmentFiles = (files: AttachedFile[]) => files.map(publicFile);
/** Restore exported Workers file references into Pi's schema without losing versions. */
export function attachmentMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) =>
    !message || !Array.isArray(message.content)
      ? message
      : {
          ...message,
          content: message.content.map((part: unknown) =>
            validFileRef(part) && typeof (part as AttachedFile).key === "string"
              ? { type: "text", text: ATTACHMENT_MARKER + JSON.stringify(part) }
              : part,
          ),
        },
  );
}
