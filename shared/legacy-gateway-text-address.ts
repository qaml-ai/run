const gatewayKey = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The same public paths reach the sticky owner before payload or credential selection. */
export function legacyGatewayTextAddress(request: Request) {
  const url = new URL(request.url);
  if (url.protocol !== "https:" || (url.host !== "run.camelai.com" && url.host !== "agents.camelai.dev")) return;
  if (request.method === "POST" && url.pathname === "/v1/runs") {
    const key = request.headers.get("idempotency-key") ?? "";
    if (gatewayKey.test(key)) return { method: "POST", key } as const;
  }
  if (request.method !== "GET") return;
  const runId = /^\/v1\/runs\/(run_[a-f0-9]{40})$/.exec(url.pathname)?.[1];
  if (runId) return { method: "GET", runId, wait: url.searchParams.get("wait") } as const;
}

export const legacyGatewayTextUncertain = () => Response.json({
  error: "The run could not be confirmed; retry the same key", code: "RUN_UNCERTAIN",
}, { status: 409, headers: { "Cache-Control": "no-store" } });
