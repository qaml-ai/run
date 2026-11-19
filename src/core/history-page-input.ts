import { HttpError } from "./http-error.ts";

/** Full-history reads (export, fork) may load at most this many stored UTF-8 bytes. */
export const FULL_HISTORY_READ_BYTES = 64 * 1024 * 1024;
/** A page returns about this much at most, beyond its first turn. */
export const PAGE_BYTES = 4_000_000;

export function historyPageInput(query: { before?: string; after?: string; limit?: string; maxBytes?: string }) {
  const before = query.before === undefined ? undefined : Number(query.before);
  const after = query.after === undefined ? undefined : Number(query.after);
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const maxBytes = query.maxBytes === undefined ? undefined : Number(query.maxBytes);
  if (before !== undefined && after !== undefined) throw new HttpError(400, "Ask for after or before, not both");
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new HttpError(400, "before is a message index");
  if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new HttpError(400, "after is a message index");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, "limit is 1 to 500 messages");
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 16_384 || maxBytes > PAGE_BYTES)) {
    throw new HttpError(400, `maxBytes is 16384 to ${PAGE_BYTES} bytes`);
  }
  return { before, after, limit, maxBytes };
}
