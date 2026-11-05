import { EndUserCredits, LEDGER_KINDS, dayInput, type LedgerKind } from "./end-user-credits.ts";
import { readText } from "./account-http.ts";
import { HttpError } from "./errors.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const page = (value: string | null, what: string) => {
  if (value === null) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new HttpError(400, `${what} must be a positive integer`);
  return number;
};
const time = (value: string | null, what: string) => {
  if (value === null) return undefined;
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) dayInput(value.slice(0, 10), what);
  const at = /^\d+$/.test(value) ? Number(value) : /^\d{4}-\d{2}-\d{2}(?:T.+)?$/.test(value) ? Date.parse(/T/.test(value) ? value : `${value}T00:00:00Z`) : NaN;
  if (!Number.isSafeInteger(at)) throw new HttpError(400, `${what} must be epoch milliseconds, a UTC day (YYYY-MM-DD) or an ISO 8601 time`);
  return at;
};
async function input(request: Request): Promise<Record<string, unknown>> {
  const text = await readText(request.body as AsyncIterable<Uint8Array> | null, 64 * 1024);
  try {
    const value = JSON.parse(text || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, "Invalid JSON body"); }
}

/** End-user settings and balances used to admit and account for model calls. */
export async function modelEndUserRoutes(request: Request, credits: EndUserCredits, tenant: string): Promise<Response | undefined> {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === "/v1/end-user-settings") {
    if (method === "GET") return json(await credits.settings(tenant));
    if (method === "PUT" || method === "PATCH") return json(await credits.setSettings(tenant, await input(request), { merge: method === "PATCH" }));
  }
  const match = /^\/v1\/end-users\/([^/]+)(?:\/(ledger|entries))?$/.exec(path);
  if (!match) return;
  let id: string;
  try { id = decodeURIComponent(match[1]); }
  catch { throw new HttpError(400, "Invalid end-user id"); }
  if (!match[2] && method === "GET") {
    const buckets = url.searchParams.get("buckets")?.split(",").filter(Boolean) ?? [];
    if (buckets.length > 50) throw new HttpError(400, "Ask for at most 50 buckets");
    return json(await credits.get(tenant, id, buckets));
  }
  if (match[2] === "entries" && method === "POST") {
    const posted = await credits.post(tenant, id, await input(request));
    return json(posted, posted.replayed ? 200 : 201);
  }
  if (match[2] === "ledger" && method === "GET") {
    const query = url.searchParams, kind = query.get("kind"), moved = query.get("moved");
    if (moved !== null && moved !== "true" && moved !== "false") throw new HttpError(400, "moved must be true or false");
    const kinds = kind?.split(",").map(value => value.trim()).filter(Boolean) as LedgerKind[] | undefined;
    if (kinds && (!kinds.length || kinds.some(value => !LEDGER_KINDS.includes(value)))) throw new HttpError(400, `kind must be a comma-separated list of ${LEDGER_KINDS.join(", ")}`);
    return json(await credits.ledger(tenant, id, {
      limit: page(query.get("limit"), "limit"), before: page(query.get("before"), "before"),
      ...(kinds ? { kinds } : {}), from: time(query.get("from"), "from"), to: time(query.get("to"), "to"),
      ...(query.has("bucket") ? { bucket: query.get("bucket")! } : {}), moved: moved === "true",
    }));
  }
}
