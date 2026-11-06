import { readableFrame, readableMessage, readableRequest, type BrowserClaims } from "./browser-tokens.ts";

/** Source browser projections for bounded JSON reads; live sockets project in the DO. */
export async function browserResponse(response: Response, claims: BrowserClaims, path: string): Promise<Response> {
  if (!response.ok || response.status === 101 || response.headers.get("content-type")?.startsWith("application/vnd.camelrun.events+json")) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const value: any = await response.json();
  const visible = path === "/events" ? { ...value, events: value.events.flatMap((event: { data: unknown }) => {
    const data = readableFrame(claims, event.data);
    return data === undefined ? [] : [{ ...event, data }];
  }) }
    : path === "/state" ? readableMessage(claims, { ...value, requests: value.requests.map(readableRequest) })
    : readableMessage(claims, value);
  return Response.json(visible, { status: response.status, headers });
}
