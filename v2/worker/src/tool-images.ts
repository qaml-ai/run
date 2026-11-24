export interface ToolImageRef {
  digest: string;
  contentType: string;
  size: number;
  width: number;
  height: number;
}

type ImageBlock = { type: "image"; data?: unknown; mimeType?: unknown };

export function toolImageContent(value: unknown): unknown[] | undefined {
  if (!value || typeof value !== "object" || !("content" in value)) return;
  const { content } = value;
  return Array.isArray(content) && content.some(isImageBlock) ? content : undefined;
}

function isImageBlock(value: unknown): value is ImageBlock {
  return !!value && typeof value === "object" && "type" in value && value.type === "image";
}

export function toolImageKey(tenantId: string, ref: ToolImageRef): string {
  return `${tenantId}/tool-images/${ref.digest}`;
}
