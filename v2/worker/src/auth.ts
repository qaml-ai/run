import {
  parseAgentTokenIds,
  parseTenantApiKeyTenant,
  sha256Hex,
} from "./crypto.ts";
import { OAUTH_ACCESS_PREFIX, resolveOAuthAccessToken } from "./oauth.ts";
import { getTenantStub } from "./tenant-do.ts";
import { ApiError, type AuthContext, type Env } from "./types.ts";

function extractRawToken(req: Request, allowQueryToken = false): string | null {
  const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  if (allowQueryToken) {
    const url = new URL(req.url);
    const q = url.searchParams.get("token");
    if (q) return q.trim();
  }
  return null;
}

export function verifyAdminHeader(env: Env, req: Request): boolean {
  const provided = req.headers.get("x-admin-key") ?? req.headers.get("X-Admin-Key");
  if (!provided || !env.ADMIN_SECRET) return false;
  return provided === env.ADMIN_SECRET;
}

export type ParsedRequestCredentials =
  | { kind: "admin"; tenantId: string }
  | { kind: "tenant"; tenantId: string; tokenHash: string }
  | { kind: "agent"; tenantId: string; agentId: string; tokenHash: string };

export async function parseRequestCredentials(
  env: Env,
  req: Request,
  options?: { allowQueryToken?: boolean; allowAdmin?: boolean; adminTenantId?: string },
): Promise<ParsedRequestCredentials> {
  if (options?.allowAdmin && verifyAdminHeader(env, req)) {
    return {
      kind: "admin",
      tenantId: options.adminTenantId ?? req.headers.get("x-tenant-id") ?? "",
    };
  }

  const token = extractRawToken(req, options?.allowQueryToken ?? false);
  if (!token) {
    throw new ApiError(401, "unauthorized", "Missing Bearer token");
  }

  const tokenHash = await sha256Hex(token);

  if (token.startsWith("cr_live_")) {
    const tenantId = parseTenantApiKeyTenant(token);
    if (!tenantId) {
      throw new ApiError(401, "unauthorized", "Invalid API key");
    }
    return { kind: "tenant", tenantId, tokenHash };
  }

  if (token.startsWith("agt_tok_")) {
    const ids = parseAgentTokenIds(token);
    if (!ids) {
      throw new ApiError(401, "unauthorized", "Invalid agent token");
    }
    return { kind: "agent", tenantId: ids.tenantId, agentId: ids.agentId, tokenHash };
  }

  throw new ApiError(401, "unauthorized", "Unrecognized token format");
}

export async function authenticateRequest(
  env: Env,
  req: Request,
  options?: { allowQueryToken?: boolean; allowAdmin?: boolean; adminTenantId?: string },
): Promise<AuthContext> {
  if (!(options?.allowAdmin && verifyAdminHeader(env, req))) {
    const raw = extractRawToken(req, options?.allowQueryToken ?? false);
    if (raw?.startsWith(OAUTH_ACCESS_PREFIX)) {
      const oauth = await resolveOAuthAccessToken(env, raw);
      if (!oauth) {
        throw new ApiError(401, "unauthorized", "Invalid or expired OAuth token");
      }
      const profile = await getTenantStub(env, oauth.tenantId).getProfile();
      if (!profile) {
        throw new ApiError(401, "unauthorized", "Account no longer exists");
      }
      return {
        kind: "tenant",
        tenantId: oauth.tenantId,
        keyId: oauth.grantId,
        scopes: oauth.scopes,
      };
    }
  }

  const creds = await parseRequestCredentials(env, req, options);
  if (creds.kind === "admin") {
    return {
      kind: "admin",
      tenantId: creds.tenantId,
      scopes: ["*"],
    };
  }

  if (creds.kind === "tenant") {
    const verified = await getTenantStub(env, creds.tenantId).verifyApiKey(creds.tokenHash);
    if (!verified) {
      throw new ApiError(401, "unauthorized", "Invalid API key");
    }
    return {
      kind: "tenant",
      tenantId: verified.tenantId,
      keyId: verified.keyId,
      scopes: verified.scopes,
    };
  }

  const verified = await getTenantStub(env, creds.tenantId).verifyAgentToken(
    creds.agentId,
    creds.tokenHash,
  );
  if (!verified) {
    throw new ApiError(401, "unauthorized", "Invalid agent token");
  }
  return {
    kind: "agent",
    tenantId: verified.tenantId,
    agentId: verified.agentId,
    scopes: ["agent:run", "agent:read", "agent:input"],
  };
}

export function assertTenantScope(auth: AuthContext): void {
  if (auth.kind === "agent") {
    throw new ApiError(403, "forbidden", "Agent-scoped tokens cannot access tenant management routes");
  }
}

export function assertAgentAccess(
  auth: AuthContext,
  targetAgentId: string,
  operation: "read" | "run" | "input" | "admin",
): void {
  if (auth.kind === "agent") {
    if (auth.agentId !== targetAgentId) {
      throw new ApiError(403, "forbidden", "Agent token is scoped to a different agent");
    }
    if (operation === "admin") {
      throw new ApiError(403, "forbidden", "Agent token cannot modify configuration or delete agents");
    }
  }
}
