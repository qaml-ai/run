import { agentListQuery, listAgentPage } from "../../../src/core/agent-directory-page.ts";
import { HttpError } from "../../../src/core/http-error.ts";
import type { Sql } from "./postgres.ts";

export async function legacyAgentList(
  request: Request,
  sql: Sql,
  principal: { tenantId: string; kind: string } | null,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/v1/agents") return;
  if (!principal || (principal.kind === "console" && request.headers.has("authorization"))) {
    throw new HttpError(401, "Invalid or missing credentials");
  }
  const page = await listAgentPage(sql, principal.tenantId, agentListQuery(url.searchParams));
  const headers = new Headers({ "cache-control": "no-store" });
  if (page.next) headers.set("x-next-cursor", page.next);
  return Response.json(page.agents, { headers });
}
