/**
 * Test your tool server's authorization without a runtime: `testRuntime()` signs identity tokens
 * (and file URLs) with a key of its own and serves its keys to `serveTools`, `verifyRuntimeToken` and `verifyFileUrl`
 * through `fetch`.
 *
 *   const runtime = await testRuntime();
 *   const handler = serveTools(tools, runtime.options); // tenant "test", as the tokens it signs say by default
 *   const result = await runtime.callTool(handler, "https://app.test/mcp", "list_todos", {}, { subject: "alice" });
 */
export interface TestIdentity {
  subject?: string; actor?: string; tenant?: string; agent?: string; definition?: string;
  context?: Record<string, unknown>; origin?: Record<string, unknown>;
}

const encode = (value: unknown) => base64url(new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)));
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function testRuntime(options: { url?: string } = {}) {
  const url = (options.url ?? "https://runtime.test").replace(/\/+$/, "");
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const kid = crypto.randomUUID();
  const jwk = { ...await crypto.subtle.exportKey("jwk", publicKey), kid, alg: "EdDSA", use: "sig" };
  const jwksUrl = `${url}/.well-known/jwks.json`;
  /** Serves this runtime's keys; any other URL goes to the real fetch. */
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target === jwksUrl) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } });
    return globalThis.fetch(input, init);
  };

  /** A token for `audience` as the runtime would sign it; `overrides` change claims or the header, to test rejections. */
  async function token(identity: TestIdentity, audience: string, overrides: { claims?: Record<string, unknown>; header?: Record<string, unknown>; expiresIn?: number } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const agent = identity.agent ?? "client_test";
    const claims = {
      iss: url, aud: audience, sub: identity.subject ?? agent, tenant: identity.tenant ?? "test", agent,
      ...(identity.definition ? { definition: identity.definition } : {}), ...(identity.context ? { ctx: identity.context } : {}),
      ...(identity.actor ? { act: identity.actor } : {}), ...(identity.origin ? { origin: identity.origin } : {}),
      iat: now, exp: now + (overrides.expiresIn ?? 120), jti: crypto.randomUUID(), ...overrides.claims,
    };
    const signed = `${encode({ alg: "EdDSA", kid, typ: "JWT", ...overrides.header })}.${encode(claims)}`;
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(signed)));
    return `${signed}.${base64url(signature)}`;
  }

  /**
   * A file URL as the runtime would send a tool (`{"$file": path}` in a call), for `verifyFileUrl` to check; `claims`
   * set or override what it grants. Only checking works: nothing serves the URL.
   */
  async function fileUrl(claims: Record<string, unknown> = {}, overrides: { header?: Record<string, unknown>; expiresIn?: number } = {}) {
    const grant = { tenant: "test", agent: "client_test", call: "call_test", tool: "app__tool", volume: "vol_test", path: "/report.pdf", agentPath: "/workspace/report.pdf", kind: "file", version: 1, ...claims };
    const signed = await token({ agent: grant.agent as string, tenant: grant.tenant as string }, "camelrun:file", { claims: grant, header: { typ: "file+jwt", ...overrides.header }, expiresIn: overrides.expiresIn ?? 300 });
    return `${url}/v1/files/${signed}/${encodeURIComponent(String(grant.path).split("/").pop() || "file")}`;
  }

  /** A JSON-RPC POST to `serverUrl`, carrying a token for `identity` (none if `identity` is null). */
  async function request(serverUrl: string, message: unknown, identity: TestIdentity | null = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (identity) headers.Authorization = `Bearer ${await token(identity, serverUrl)}`;
    return new Request(serverUrl, { method: "POST", headers, body: JSON.stringify(message) });
  }

  /** Call one tool through a fetch handler as `identity`: its CallToolResult, or the JSON-RPC error thrown. */
  async function callTool(handler: (request: Request) => Promise<Response>, serverUrl: string, name: string, args: Record<string, unknown>, identity: TestIdentity) {
    const response = await handler(await request(serverUrl, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, identity));
    const body = await response.json() as any;
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error ?? JSON.stringify(body)}`);
    if (body.error) throw new Error(body.error.message);
    return body.result as { content: Array<Record<string, unknown>>; structuredContent?: Record<string, unknown>; isError?: boolean };
  }

  return { url, jwk, token, fileUrl, request, callTool, fetch: fetcher, options: { runtime: url, fetch: fetcher, tenant: "test" } };
}
