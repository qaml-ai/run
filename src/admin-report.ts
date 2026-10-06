import { randomUUID } from "node:crypto";
import { adminDays, type AdminRange } from "./admin-signals.ts";
import { safeError } from "./metrics.ts";
import { signedHeaders } from "./webhooks.ts";

/**
 * A report of the journey store's (the operator's own analytics store, which src/journey.ts sends events to), asked
 * for by the team's admin site (src/admin-site.ts, POST /api/report): sign-ups, first runs and payments by day
 * (`signals`), the accounts active in a range (`journeys`), or one account's events (`journey`). The store names an
 * account by its `account_ref` only.
 */
export interface AdminReportRequest extends AdminRange { schema_version: 1; kind: "signals" | "journeys" | "journey"; account_ref?: string; cursor?: string }
/** Where the store answers reports, and the Standard Webhooks secret requests are signed with: its own, never the one events are signed with. */
export interface AdminReportSource { url: string; secret: string }

/** The path of the store's report endpoint, under AGENT_JOURNEY_URL. */
export const ADMIN_REPORT_PATH = "/api/journey/admin-report";
export const ADMIN_REPORT_REQUEST_BYTES = 4096;
const RESPONSE_BYTES = 2_000_000;
const TIMEOUT_MS = 25_000;
// What the store may say of a request that the site passes on; anything else is the store being unavailable.
const REFUSALS = ["invalid_date", "invalid_range", "invalid_time_zone", "invalid_cursor", "invalid_account_ref", "account_not_found", "account_deleted", "range_too_long", "report_too_large"];
const UNCONFIGURED = ["report_not_configured", "report_secret_must_be_separate", "signing_not_configured"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A body's text, read no further than `limit` bytes. */
export async function boundedText(from: { body: ReadableStream<Uint8Array> | null }, limit: number) {
  if (!from.body) throw new Error("no body");
  const reader = from.body.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error("too large"); }
    parts.push(part.value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
}

/** The request a body asks for, with nothing the store does not read; undefined for anything else. */
export function adminReportRequest(input: unknown): AdminReportRequest | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const request = input as Record<string, unknown>;
  if (Object.keys(request).some(key => !["schema_version", "kind", "start_date", "end_date", "time_zone", "account_ref", "cursor"].includes(key))) return undefined;
  const { kind, account_ref: account, cursor } = request;
  if (request.schema_version !== 1 || (kind !== "signals" && kind !== "journeys" && kind !== "journey")) return undefined;
  const range = { start_date: request.start_date, end_date: request.end_date, time_zone: request.time_zone } as AdminRange;
  try { adminDays(range); } catch { return undefined; }
  if (kind === "journey" ? typeof account !== "string" || !UUID.test(account) : account !== undefined) return undefined;
  if (cursor !== undefined && (kind === "signals" || typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,300}$/.test(cursor))) return undefined;
  return { schema_version: 1, kind, ...range, ...(account === undefined ? {} : { account_ref: account as string }), ...(cursor === undefined ? {} : { cursor: cursor as string }) };
}

/**
 * The store's answer to a report request, or `{ error }`: 503 `report_not_configured` where no store is configured
 * to answer (here or there), 502 `report_unavailable` where it could not be reached or said something else than a
 * report of what was asked (`reason` says which, for the log). One signed request: never a redirect followed, and no
 * more read than a report is long.
 */
export async function adminReport(request: AdminReportRequest, source: AdminReportSource | undefined, fetcher: typeof fetch = fetch): Promise<{ status: number; body: unknown; reason?: string }> {
  if (!source) return { status: 503, body: { error: "report_not_configured" } };
  const raw = JSON.stringify(request);
  try {
    const response = await fetcher(source.url, {
      method: "POST", headers: { "content-type": "application/json", ...signedHeaders(randomUUID(), raw, [source.secret]) }, body: raw,
      redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = JSON.parse(await boundedText(response, RESPONSE_BYTES));
    if (!response.ok) {
      const code = typeof data?.error === "string" ? data.error : "";
      if (REFUSALS.includes(code) && [400, 404, 410, 422].includes(response.status)) return { status: response.status, body: { error: code } };
      const reason = `the store answered ${response.status}${/^[a-z_]{1,64}$/.test(code) ? ` ${code}` : ""}`;
      return UNCONFIGURED.includes(code) ? { status: 503, body: { error: "report_not_configured" }, reason } : { status: 502, body: { error: "report_unavailable" }, reason };
    }
    const range = data?.range;
    if (data?.schema_version !== 1 || data.kind !== request.kind || range?.start_date !== request.start_date || range?.end_date !== request.end_date || range?.time_zone !== request.time_zone) {
      return { status: 502, body: { error: "report_unavailable" }, reason: "the store answered with another report than was asked for" };
    }
    return { status: 200, body: data };
  } catch (error) { return { status: 502, body: { error: "report_unavailable" }, reason: safeError(error) }; }
}
