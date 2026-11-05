import type { FileBindings } from "./files.ts";
import { attachmentMarker, type AttachedFile } from "./attachment-markers.ts";

/** A fork may inherit only immutable versions already authorized to its source. */
export async function inheritHistoryPins(env: FileBindings, tenant: string, source: string, target: string, messages: unknown[]) {
  const volumes = new Map<string, Set<string>>();
  for (const message of messages as { content?: unknown }[]) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const file = part?.type === "file" ? part as AttachedFile : part?.type === "text" && typeof part.text === "string" ? attachmentMarker(part.text) : undefined;
      if (!file?.key?.startsWith(`files/${encodeURIComponent(tenant)}/`)) continue;
      const volume = decodeURIComponent(file.key.split("/")[2] ?? "");
      if (!volume || !await env.VOLUMES.getByName(`${tenant}:${volume}`).hasPin(`agent:${source}`, file.key)) continue;
      const keys = volumes.get(volume) ?? new Set();
      keys.add(file.key);
      volumes.set(volume, keys);
    }
  }
  for (const [volume, keys] of volumes) await env.VOLUMES.getByName(`${tenant}:${volume}`).pin(`agent:${target}`, [...keys]);
  return [...volumes.keys()];
}
