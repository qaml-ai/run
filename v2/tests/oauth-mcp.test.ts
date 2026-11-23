import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import type {
  AdminAccountDetail,
  AdminAcquisition,
  AdminMcp,
  AdminUsage,
} from "../../shared/ops-types.ts";
import { sealConsoleSession } from "../ingress/console.ts";
import ingressWorker from "../ingress/index.ts";
import { mcpClientKind } from "../worker/src/mcp-client-kind.ts";

const ADMIN_KEY = "test-admin-secret-oauth-mcp";
const VAULT_SECRET = "test-vault-secret-oauth-mcp-32bytes";
const CONSOLE_SESSION_SECRET = "test-console-session-secret-oauth-mcp";
const ORIGIN = "https://run.camelai.com";
const MCP_ACCEPT = "application/json, text/event-stream";

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function parseSseJsonMessages(raw: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n");
    if (!payload) continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      // Ignore non-JSON comments
    }
  }
  return out;
}

async function readMcpJson(res: Response): Promise<Record<string, any> | undefined> {
  const ct = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  if (ct.includes("text/event-stream")) {
    return parseSseJsonMessages(raw).find((m) => "result" in m || "error" in m);
  }
  const parsed = raw ? JSON.parse(raw) : undefined;
  const arr = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return arr.find((m) => "result" in m || "error" in m);
}

test("mcpClientKind classifies ChatGPT, Claude, Codex, and other clients from OAuth metadata", () => {
  assert.equal(mcpClientKind("Some App", ["https://chatgpt.com/connector_platform_oauth_redirect"]), "chatgpt");
  assert.equal(mcpClientKind("Some App", ["https://chat.openai.com/aip/g/oauth/callback"]), "chatgpt");
  assert.equal(mcpClientKind("Some App", ["https://claude.ai/api/mcp/auth_callback"]), "claude");
  assert.equal(mcpClientKind("Codex", ["http://127.0.0.1:4321/callback"]), "codex");
  assert.equal(mcpClientKind("Claude Code", ["http://localhost:8787/cb"]), "claude");
  assert.equal(mcpClientKind("Cursor", ["cursor://oauth/callback"]), "other");
});

test("v2 OAuth 2.1 Authorization Server + Hosted MCP + Ops Attribution end-to-end (R2-backed, zero DO changes)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "camelrun-oauth-mcp-"));
  const config = join(dir, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "oauth-mcp-test",
      main: fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: ADMIN_KEY,
        VAULT_SECRET,
        CAMELFS_URL: "http://127.0.0.1:1",
        VOICE_PUBLIC_URL: ORIGIN,
      },
      r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: "camelrun-media-v2" }],
      durable_objects: {
        bindings: [
          { name: "TENANT_DO", class_name: "TenantDO" },
          { name: "AGENT_DO", class_name: "AgentDO" },
          { name: "VOICE_CALL_DO", class_name: "VoiceCallDO" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] },
        { tag: "v2", new_sqlite_classes: ["VoiceCallDO"] },
      ],
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());

  // Wire v2 ingress in front of the real Miniflare worker
  const ingressEnv = {
    V2: {
      fetch: async (req: Request) => {
        const res = await worker.fetch(req.url, {
          method: req.method,
          headers: [...req.headers.entries()],
          body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        return res as unknown as Response;
      },
    },
    ADMIN_SECRET: ADMIN_KEY,
    CONSOLE_SESSION_SECRET,
    ASSETS: {
      fetch: async () => new Response("<!doctype html><html><body>console</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
    },
  };

  const ingressFetch = (path: string, init?: RequestInit) =>
    ingressWorker.fetch(new Request(`${ORIGIN}${path}`, init), ingressEnv);

  const adminFetch = (path: string, init?: { method?: string; body?: string }) =>
    worker.fetch(`${ORIGIN}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        "X-Admin-Key": ADMIN_KEY,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init?.body ? { body: init.body } : {}),
      signal: AbortSignal.timeout(15_000),
    });

  // 1. OAuth 2.1 Discovery Metadata (RFC 8414 & RFC 9728)
  const asMetaRes = await ingressFetch("/.well-known/oauth-authorization-server");
  assert.equal(asMetaRes.status, 200);
  const asMeta = (await asMetaRes.json()) as Record<string, unknown>;
  assert.equal(asMeta.issuer, ORIGIN);
  assert.equal(asMeta.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(asMeta.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(asMeta.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.equal(asMeta.revocation_endpoint, `${ORIGIN}/oauth/revoke`);
  assert.deepEqual(asMeta.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(asMeta.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(asMeta.response_types_supported, ["code"]);
  assert.deepEqual(asMeta.scopes_supported, ["agents", "mcp"]);

  for (const [metaPath, expectedResource] of [
    ["/.well-known/oauth-protected-resource", `${ORIGIN}/mcp`],
    ["/.well-known/oauth-protected-resource/mcp", `${ORIGIN}/mcp`],
    ["/.well-known/oauth-protected-resource/v2/mcp", `${ORIGIN}/v2/mcp`],
  ] as const) {
    const res = await ingressFetch(metaPath);
    assert.equal(res.status, 200, metaPath);
    const body = (await res.json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
    assert.equal(body.resource, expectedResource, metaPath);
    assert.deepEqual(body.authorization_servers, [ORIGIN], metaPath);
    assert.deepEqual(body.scopes_supported, ["agents"], metaPath);
  }

  // Unauthenticated /mcp returns 401 pointing to /.well-known/oauth-protected-resource/mcp
  const unauthMcp = await ingressFetch("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  assert.equal(unauthMcp.status, 401);
  assert.match(
    unauthMcp.headers.get("www-authenticate") ?? "",
    /resource_metadata="https:\/\/run\.camelai\.com\/\.well-known\/oauth-protected-resource\/mcp"/,
  );

  // 2. RFC 7591 Dynamic Client Registration (ChatGPT)
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const regRes = await ingressFetch("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT",
      redirect_uris: [redirectUri],
    }),
  });
  assert.equal(regRes.status, 201);
  const client = (await regRes.json()) as {
    client_id: string;
    client_name: string;
    redirect_uris: string[];
    token_endpoint_auth_method: string;
  };
  assert.match(client.client_id, /^mcp_[a-f0-9]+$/);
  assert.equal(client.client_name, "ChatGPT");
  assert.deepEqual(client.redirect_uris, [redirectUri]);
  assert.equal(client.token_endpoint_auth_method, "none");

  // 3. Provision a self-serve user (Alice) via Console auth backend
  const signupRes = await adminFetch("/v2/admin/console/oauth-login", {
    method: "POST",
    body: JSON.stringify({
      provider: "google",
      externalId: "google-alice-1",
      email: "alice@example.com",
      login: "alice@example.com",
      name: "Alice User",
    }),
  });
  assert.equal(signupRes.status, 200);
  const alice = (await signupRes.json()) as { tenantId: string; apiKey: string; email: string };

  // Also grant Alice credits so mock agent runs succeed
  const creditRes = await adminFetch("/v2/admin/ops/account/credits", {
    method: "POST",
    body: JSON.stringify({ tenantId: alice.tenantId, amountUsd: 5, note: "test credits" }),
  });
  assert.equal(creditRes.status, 200);

  // 4. Authorization Endpoint: unauthenticated -> redirects to /console/sign-in?next=...
  const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk_extra_entropy_12345";
  const codeChallenge = pkceS256(codeVerifier);
  const authQuery = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: "state-abc-123",
    scope: "agents mcp",
  }).toString();

  const unauthAuthz = await ingressFetch(`/oauth/authorize?${authQuery}`);
  assert.equal(unauthAuthz.status, 302);
  const signInLoc = unauthAuthz.headers.get("location") ?? "";
  assert.ok(signInLoc.startsWith("/console/sign-in?next="), `unexpected redirect: ${signInLoc}`);
  const decodedNext = decodeURIComponent(signInLoc.slice("/console/sign-in?next=".length));
  assert.equal(decodedNext, `/oauth/authorize?${authQuery}`);

  // Header-spoofing attempt through ingress MUST be stripped and rejected to sign-in
  const spoofAuthz = await ingressFetch(`/oauth/authorize?${authQuery}`, {
    headers: {
      "X-Admin-Key": ADMIN_KEY,
      "X-OAuth-Session": JSON.stringify({ tenantId: alice.tenantId, email: alice.email }),
    },
  });
  assert.equal(spoofAuthz.status, 302);
  assert.ok((spoofAuthz.headers.get("location") ?? "").startsWith("/console/sign-in?next="));

  // Verify Console password signup accepts `/oauth/authorize?...` in `next`
  const pwSignupRes = await ingressFetch("/console/auth/signup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "X-Agent-Runtime-Console": "1",
    },
    body: JSON.stringify({
      email: "bob-oauth@example.com",
      password: "super-secure-password-123",
      name: "Bob OAuth",
      next: `/oauth/authorize?${authQuery}`,
    }),
  });
  assert.equal(pwSignupRes.status, 201);
  const pwSignupJson = (await pwSignupRes.json()) as { ok: boolean; next?: string };
  assert.equal(pwSignupJson.next, `/oauth/authorize?${authQuery}`);

  // 5. Authenticated Consent Screen via sealed Console session cookie
  const sessionCookie = await sealConsoleSession(
    {
      tenantId: alice.tenantId,
      apiKey: alice.apiKey,
      email: alice.email,
      login: alice.email,
      name: "Alice User",
      provider: "google",
      exp: Date.now() + 3600_000,
    },
    CONSOLE_SESSION_SECRET,
  );

  const consentRes = await ingressFetch(`/oauth/authorize?${authQuery}`, {
    headers: { Cookie: `cr_console=${sessionCookie}` },
  });
  assert.equal(consentRes.status, 200);
  const consentHtml = await consentRes.text();
  assert.match(consentHtml, /ChatGPT/);
  assert.match(consentHtml, /alice@example\.com/);
  assert.match(consentHtml, /Approve/);
  assert.match(consentHtml, /Deny/);

  const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(consentHtml);
  assert.ok(csrfMatch?.[1], "expected csrf_token hidden input on consent page");
  const csrfToken = csrfMatch[1];
  const csrfCookieHeader = consentRes.headers.get("set-cookie") ?? "";
  const csrfCookieVal = /cr_oauth_csrf=([^;]+)/.exec(csrfCookieHeader)?.[1];
  assert.ok(csrfCookieVal, "expected cr_oauth_csrf cookie");
  const fullCookie = `cr_console=${sessionCookie}; cr_oauth_csrf=${csrfCookieVal}`;

  // Missing CSRF token -> 403
  const badCsrfRes = await ingressFetch("/oauth/authorize", {
    method: "POST",
    headers: {
      Cookie: fullCookie,
      Origin: ORIGIN,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `${authQuery}&decision=allow&csrf_token=invalid`,
  });
  assert.equal(badCsrfRes.status, 403);

  // Deny decision -> 302 with error=access_denied
  const denyRes = await ingressFetch("/oauth/authorize", {
    method: "POST",
    headers: {
      Cookie: fullCookie,
      Origin: ORIGIN,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `${authQuery}&decision=deny&csrf_token=${encodeURIComponent(csrfToken)}`,
  });
  assert.equal(denyRes.status, 302);
  const denyUrl = new URL(denyRes.headers.get("location")!);
  assert.equal(denyUrl.searchParams.get("error"), "access_denied");
  assert.equal(denyUrl.searchParams.get("state"), "state-abc-123");

  // Approve decision -> 302 with single-use PKCE auth code
  const approveRes = await ingressFetch("/oauth/authorize", {
    method: "POST",
    headers: {
      Cookie: fullCookie,
      Origin: ORIGIN,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `${authQuery}&decision=allow&csrf_token=${encodeURIComponent(csrfToken)}`,
  });
  assert.equal(approveRes.status, 302);
  const callbackUrl = new URL(approveRes.headers.get("location")!);
  assert.equal(`${callbackUrl.origin}${callbackUrl.pathname}`, redirectUri);
  assert.equal(callbackUrl.searchParams.get("state"), "state-abc-123");
  assert.equal(callbackUrl.searchParams.get("iss"), ORIGIN);
  const authCode = callbackUrl.searchParams.get("code") ?? "";
  assert.match(authCode, /^arc_/);

  // 6. Token Exchange with PKCE S256: rejects wrong verifier, accepts right verifier
  const wrongPkceRes = await ingressFetch("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: authCode,
      redirect_uri: redirectUri,
      code_verifier: "wrong_verifier_with_valid_length_1234567890123456789012345",
    }).toString(),
  });
  assert.equal(wrongPkceRes.status, 400);
  assert.equal(((await wrongPkceRes.json()) as { error: string }).error, "invalid_grant");

  const tokenRes = await ingressFetch("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: authCode,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }).toString(),
  });
  assert.equal(tokenRes.status, 200);
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  };
  assert.match(tokens.access_token, /^aro_/);
  assert.match(tokens.refresh_token, /^arr_/);
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 3600);

  // Replaying the consumed auth code MUST fail
  const replayCodeRes = await ingressFetch("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: authCode,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }).toString(),
  });
  assert.equal(replayCodeRes.status, 400);
  assert.equal(((await replayCodeRes.json()) as { error: string }).error, "invalid_grant");

  // 7. Call POST /mcp with Bearer aro_... -> initialize, whoami, upsert_agent, send_message, per-agent MCP
  const postMcp = (path: string, payload: unknown, token: string) =>
    ingressFetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: MCP_ACCEPT,
      },
      body: JSON.stringify(payload),
    });

  const initRes = await postMcp(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "ChatGPT", version: "1.0.0" },
      },
    },
    tokens.access_token,
  );
  assert.equal(initRes.status, 200);
  const initMsg = await readMcpJson(initRes);
  assert.equal(initMsg?.result?.serverInfo?.name, "camelrun");

  const whoamiRes = await postMcp(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    },
    tokens.access_token,
  );
  assert.equal(whoamiRes.status, 200);
  const whoamiMsg = await readMcpJson(whoamiRes);
  assert.equal(whoamiMsg?.result?.isError, undefined);
  const whoamiData = JSON.parse(whoamiMsg?.result?.content?.[0]?.text ?? "{}") as { tenantId: string };
  assert.equal(whoamiData.tenantId, alice.tenantId);

  // Create an agent and run a turn via OAuth token (uses zero new TenantDO RPCs!)
  const upsertRes = await postMcp(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "upsert_agent",
        arguments: {
          key: "chatgpt-helper",
          model: "mock/echo",
          instructions: "Helpful OAuth agent",
        },
      },
    },
    tokens.access_token,
  );
  assert.equal(upsertRes.status, 200);
  const upsertMsg = await readMcpJson(upsertRes);
  assert.equal(upsertMsg?.result?.isError, undefined, JSON.stringify(upsertMsg));

  const sendRes = await postMcp(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: {
          agent: "chatgpt-helper",
          message: "Hello from ChatGPT OAuth!",
          wait: true,
        },
      },
    },
    tokens.access_token,
  );
  assert.equal(sendRes.status, 200);
  const sendMsg = await readMcpJson(sendRes);
  assert.equal(sendMsg?.result?.isError, undefined, JSON.stringify(sendMsg));
  const sendData = JSON.parse(sendMsg?.result?.content?.[0]?.text ?? "{}") as { status: string; text: string };
  assert.equal(sendData.status, "completed");
  assert.match(sendData.text, /Hello from ChatGPT OAuth!/);

  // Per-agent MCP endpoint also accepts Bearer aro_...
  const perAgentInit = await postMcp(
    "/v2/agents/chatgpt-helper/mcp",
    {
      jsonrpc: "2.0",
      id: 5,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "ChatGPT", version: "1.0.0" },
      },
    },
    tokens.access_token,
  );
  assert.equal(perAgentInit.status, 200);

  // Active grant appears in ops usage + account detail `mcp_clients`
  const usageBeforeRevoke = (await (await adminFetch("/v2/admin/ops/usage?days=30")).json()) as AdminUsage;
  assert.deepEqual(usageBeforeRevoke.mcp_clients, [{ client: "ChatGPT", accounts: 1 }]);
  assert.ok(usageBeforeRevoke.integrations.some((i) => i.key === "mcp_clients" && i.accounts === 1));

  const detailBeforeRevoke = (await (
    await adminFetch(`/v2/admin/ops/account?tenant=${encodeURIComponent(alice.tenantId)}&days=30`)
  ).json()) as AdminAccountDetail;
  assert.deepEqual(detailBeforeRevoke.mcp_clients, ["ChatGPT"]);

  // 8. Refresh token rotation
  const refreshRes = await ingressFetch("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
    }).toString(),
  });
  assert.equal(refreshRes.status, 200);
  const rotated = (await refreshRes.json()) as { access_token: string; refresh_token: string };
  assert.match(rotated.access_token, /^aro_/);
  assert.match(rotated.refresh_token, /^arr_/);
  assert.notEqual(rotated.access_token, tokens.access_token);
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);

  // Rotated access token works on /mcp
  const rotatedWhoami = await postMcp(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    },
    rotated.access_token,
  );
  assert.equal(rotatedWhoami.status, 200);

  // 9. Token revocation (RFC 7009) -> revokes grant; revoked tokens rejected with 401
  const revokeRes = await ingressFetch("/oauth/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      token: rotated.access_token,
    }).toString(),
  });
  assert.equal(revokeRes.status, 200);

  for (const deadToken of [tokens.access_token, rotated.access_token]) {
    const rejected = await postMcp(
      "/mcp",
      { jsonrpc: "2.0", id: 7, method: "initialize" },
      deadToken,
    );
    assert.equal(rejected.status, 401);
    assert.match(rejected.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  }

  const deadRefresh = await ingressFetch("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: rotated.refresh_token,
    }).toString(),
  });
  assert.equal(deadRefresh.status, 400);
  assert.equal(((await deadRefresh.json()) as { error: string }).error, "invalid_grant");

  // Active mcp_clients is now empty after revocation
  const detailAfterRevoke = (await (
    await adminFetch(`/v2/admin/ops/account?tenant=${encodeURIComponent(alice.tenantId)}&days=30`)
  ).json()) as AdminAccountDetail;
  assert.deepEqual(detailAfterRevoke.mcp_clients, []);

  // 10. Ops MCP & Acquisition endpoints reflect ChatGPT authorization & signup attribution
  const opsMcpRes = await adminFetch("/v2/admin/ops/mcp?days=30");
  assert.equal(opsMcpRes.status, 200);
  const opsMcp = (await opsMcpRes.json()) as AdminMcp;
  const chatgptFunnel = opsMcp.funnel.find((f) => f.kind === "chatgpt");
  assert.ok(chatgptFunnel, "expected chatgpt funnel row");
  assert.equal(chatgptFunnel.authorized, 1);
  assert.equal(chatgptFunnel.made_agent, 1);
  assert.equal(chatgptFunnel.ran_turn, 1);

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayChatgpt = opsMcp.daily.find((d) => d.date === todayStr && d.kind === "chatgpt");
  assert.ok(todayChatgpt, "expected today's chatgpt daily row");
  assert.equal(todayChatgpt.signups, 1);
  assert.equal(todayChatgpt.token_active_accounts, 1);

  const activeWeekChatgpt = opsMcp.weekly.find((w) => w.kind === "chatgpt" && w.token_active_accounts > 0);
  assert.ok(activeWeekChatgpt, "expected weekly chatgpt token_active_accounts >= 1");
  assert.equal(activeWeekChatgpt.token_active_accounts, 1);

  const opsAcqRes = await adminFetch("/v2/admin/ops/acquisition?days=30");
  assert.equal(opsAcqRes.status, 200);
  const opsAcq = (await opsAcqRes.json()) as AdminAcquisition;
  const chatgptSource = opsAcq.sources.find((s) => s.kind === "plugin" && s.source === "ChatGPT plugin");
  assert.ok(chatgptSource, `expected ChatGPT plugin source in ${JSON.stringify(opsAcq.sources)}`);
  assert.equal(chatgptSource.signups, 1);
  assert.equal(chatgptSource.made_agent, 1);
  assert.equal(chatgptSource.activated, 1);
});
