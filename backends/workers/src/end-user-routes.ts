import { EndUserCredits, dayInput, LEDGER_KINDS, type LedgerKind } from "./end-user-credits.ts";
import { HttpError } from "./errors.ts";
import { readText } from "./account-http.ts";

// The HTTP adapter follows src/end-users-api.ts. All validation, locking, holds,
// lot expiry and ledger mutations remain in the source-derived credit service.
const page = (value: string | undefined, what: string) => {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new HttpError(400, `${what} must be a positive integer`);
  return number;
};
const kinds = (value: string) => {
  const list = value.split(",").map(kind => kind.trim()).filter(Boolean);
  if (!list.length || list.some(kind => !(LEDGER_KINDS as readonly string[]).includes(kind))) throw new HttpError(400, `kind must be a comma-separated list of ${LEDGER_KINDS.join(", ")}`);
  return list as LedgerKind[];
};
const time = (value: string | undefined, what: string) => {
  if (value === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) dayInput(value.slice(0, 10), what);
  const at = /^\d+$/.test(value) ? Number(value) : /^\d{4}-\d{2}-\d{2}(?:T.+)?$/.test(value) ? Date.parse(/T/.test(value) ? value : `${value}T00:00:00Z`) : NaN;
  if (!Number.isSafeInteger(at)) throw new HttpError(400, `${what} must be epoch milliseconds, a UTC day (YYYY-MM-DD) or an ISO 8601 time`);
  return at;
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
async function read(request: Request): Promise<Record<string, unknown>> {
  const text = await readText(request.body as AsyncIterable<Uint8Array> | null, 64 * 1024);
  try { return JSON.parse(text || "{}"); }
  catch { throw new HttpError(400, "Invalid JSON"); }
}

export async function endUserRoutes(request: Request, tenant: string, service: EndUserCredits): Promise<Response | undefined> {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  const query = (name: string) => url.searchParams.get(name) ?? undefined;
  if (path === "/v1/end-user-settings") {
    if (method === "GET") return json(await service.settings(tenant));
    if (method === "PUT" || method === "PATCH") return json(await service.setSettings(tenant, await read(request), { merge: method === "PATCH" }));
  }
  if (path === "/v1/end-users" && method === "GET") {
    const below = query("belowLowBalance");
    if (below !== undefined && below !== "true" && below !== "false") throw new HttpError(400, "belowLowBalance must be true or false");
    return json(await service.list(tenant, { limit: page(query("limit"), "limit"), after: query("after"), belowLowBalance: below === "true" }));
  }
  const match = /^\/v1\/end-users\/([^/]+)(?:\/(ledger|usage|days|lots|entries))?$/.exec(path);
  if (!match) return;
  const id = decodeURIComponent(match[1]), action = match[2];
  if (!action) {
    if (method === "GET") {
      const buckets = query("buckets")?.split(",").filter(Boolean) ?? [];
      if (buckets.length > 50) throw new HttpError(400, "Ask for at most 50 buckets");
      return json(await service.get(tenant, id, buckets));
    }
    if (method === "PATCH") return json(await service.update(tenant, id, await read(request)));
  }
  if (action === "ledger" && method === "GET") {
    const kind = query("kind"), moved = query("moved");
    if (moved !== undefined && moved !== "true" && moved !== "false") throw new HttpError(400, "moved must be true or false");
    return json(await service.ledger(tenant, id, {
      limit: page(query("limit"), "limit"), before: page(query("before"), "before"),
      ...(kind !== undefined ? { kinds: kinds(kind) } : {}), from: time(query("from"), "from"), to: time(query("to"), "to"),
      ...(query("bucket") !== undefined ? { bucket: query("bucket") } : {}), moved: moved === "true",
    }));
  }
  if (action === "usage" && method === "GET") return json(await service.usage(tenant, id, {
    from: time(query("from"), "from"), to: time(query("to"), "to"),
    step: query("step") as "hour" | "day" | undefined, bucket: query("bucket"),
  }));
  if (action === "days" && method === "GET") return json(await service.days(tenant, id, {
    from: query("from"), to: query("to"), bucket: query("bucket"), limit: page(query("limit"), "limit"),
  }));
  if (action === "lots" && method === "POST") {
    const marked = await service.markLot(tenant, id, await read(request));
    return json(marked, marked.replayed ? 200 : 201);
  }
  if (action === "entries" && method === "POST") {
    const posted = await service.post(tenant, id, await read(request));
    return json(posted, posted.replayed ? 200 : 201);
  }
}
