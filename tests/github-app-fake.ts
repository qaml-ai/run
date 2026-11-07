import { generateKeyPairSync, randomBytes, verify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

/**
 * A local stand-in for GitHub's REST API as a GitHub App sees it, for the GitHub App cases on every backend: the real one
 * is never called. It checks App JWTs (RS256) against the App's current public keys, finds installations by repository,
 * owner or list, issues installation tokens scoped to the repositories and permissions asked for, revokes them, and
 * converts manifest codes. `GET /repos/{owner}/{repo}` and git's smart HTTP paths answer only for a token that reaches
 * that repository, so a case can tell a scoped token from one that is not.
 */

export const APP_ID = 5151;
export const APP_SLUG = "camel-code";
export const WEBHOOK_SECRET = "fixture-app-webhook-secret";
/** Installations by account: acme's reaches acme/app and acme/other; solo's reaches solo/tool. */
export const INSTALLATIONS: Record<string, { id: number; repositories: string[] }> = {
  acme: { id: 101, repositories: ["app", "other"] },
  solo: { id: 202, repositories: ["tool"] },
};

export const newKey = () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { pem: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString(), publicKey: pair.publicKey };
};

export type Issued = { token: string; installation: number; account: string; repositories: string[]; permissions: Record<string, string>; revoked: boolean };

export async function fakeGitHubApp(t: { after(fn: () => Promise<void> | void): void }) {
  const first = newKey();
  const state = {
    /** Public keys GitHub accepts for the App's JWTs; a rotation adds one and (when the old is deleted) removes the other. */
    keys: [first.publicKey] as KeyObject[],
    pem: first.pem,
    issued: [] as Issued[],
    /** Every request: method, path and whether it carried a valid App JWT, never the token itself. */
    requests: [] as { method: string; path: string; jwt?: boolean; body?: any }[],
    manifests: new Map<string, { used: boolean }>(),
  };
  const jwtValid = (auth: string) => {
    const [header, payload, signature] = auth.split(".");
    if (!signature) return false;
    if (!state.keys.some(key => verify("sha256", Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, "base64url")))) return false;
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    const now = Math.floor(Date.now() / 1000);
    return JSON.parse(Buffer.from(header!, "base64url").toString()).alg === "RS256" && claims.iss === String(APP_ID) && claims.exp > now && claims.iat <= now && claims.exp - claims.iat <= 600;
  };
  const tokenFor = (authorization?: string) => {
    const value = authorization?.replace(/^(?:Bearer|token) /, "") ?? "";
    const basic = /^Basic (.+)$/.exec(authorization ?? "")?.[1];
    const token = basic ? Buffer.from(basic, "base64").toString().replace(/^x-access-token:/, "") : value;
    return state.issued.find(entry => entry.token === token && !entry.revoked);
  };
  /** Whether a token reaches `owner/repo`. */
  const reaches = (issued: Issued | undefined, owner: string, repo: string) => !!issued && issued.account === owner && issued.repositories.includes(repo);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    let body: any;
    try { body = raw && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    const path = new URL(req.url!, "http://local").pathname;
    const answer = (value: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    const auth = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const appRoute = path === "/app" || path.startsWith("/app/") || /^\/(?:repos\/[^/]+\/[^/]+|orgs\/[^/]+|users\/[^/]+)\/installation$/.test(path);
    state.requests.push({ method: req.method!, path, ...(appRoute ? { jwt: jwtValid(auth) } : {}), ...(body ? { body } : {}) });

    const manifest = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
    if (manifest && req.method === "POST") {
      const entry = state.manifests.get(manifest[1]!);
      if (!entry || entry.used) return answer({ message: "Not Found" }, 404);
      entry.used = true;
      return answer({ id: APP_ID, slug: APP_SLUG, name: "camelCode", owner: { login: "acme" }, html_url: `https://github.com/apps/${APP_SLUG}`,
        pem: state.pem, webhook_secret: WEBHOOK_SECRET, client_id: "Iv1.fixture", client_secret: "fixture-client-secret" }, 201);
    }
    if (appRoute) {
      if (!jwtValid(auth)) return answer({ message: "A JSON web token could not be decoded" }, 401);
      if (path === "/app") return answer({ id: APP_ID, slug: APP_SLUG, name: "camelCode", owner: { login: "acme" }, html_url: `https://github.com/apps/${APP_SLUG}` });
      if (path === "/app/installations") return answer(Object.entries(INSTALLATIONS).map(([login, value]) => ({ id: value.id, account: { login } })));
      const byRepo = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path);
      if (byRepo) {
        const found = INSTALLATIONS[byRepo[1]!];
        return found?.repositories.includes(byRepo[2]!) ? answer({ id: found.id, account: { login: byRepo[1] } }) : answer({ message: "Not Found" }, 404);
      }
      const byOwner = /^\/(orgs|users)\/([^/]+)\/installation$/.exec(path);
      if (byOwner) {
        const found = byOwner[1] === "orgs" ? (byOwner[2] === "acme" ? INSTALLATIONS.acme : undefined) : INSTALLATIONS[byOwner[2]!];
        return found ? answer({ id: found.id, account: { login: byOwner[2] } }) : answer({ message: "Not Found" }, 404);
      }
      const minting = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (minting && req.method === "POST") {
        const [account, installation] = Object.entries(INSTALLATIONS).find(([, value]) => String(value.id) === minting[1]) ?? [];
        if (!installation) return answer({ message: "Not Found" }, 404);
        const asked: string[] | undefined = body?.repositories;
        if (asked?.some(name => !installation.repositories.includes(name))) return answer({ message: "There is at least one repository that does not exist or is not accessible to the parent installation." }, 422);
        const issued: Issued = { token: `ghs_${randomBytes(18).toString("hex")}`, installation: installation.id, account: account!, repositories: asked ?? installation.repositories, permissions: body?.permissions ?? { contents: "write", metadata: "read" }, revoked: false };
        state.issued.push(issued);
        return answer({ token: issued.token, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: issued.permissions, repository_selection: asked ? "selected" : "all" }, 201);
      }
      return answer({ message: "Not Found" }, 404);
    }
    const issued = tokenFor(req.headers.authorization);
    if (path === "/installation/token" && req.method === "DELETE") {
      if (!issued) return answer({ message: "Bad credentials" }, 401);
      issued.revoked = true;
      return res.writeHead(204).end();
    }
    if (!issued) return answer({ message: "Bad credentials" }, 401);
    const repo = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (repo && req.method === "GET") return reaches(issued, repo[1]!, repo[2]!) ? answer({ full_name: `${repo[1]}/${repo[2]}`, private: true }) : answer({ message: "Not Found" }, 404);
    answer({ message: "Not Found" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url, state, reaches, tokenFor,
    /** A new key for the App, as its settings page generates one; `revokeOld` deletes the old one at GitHub. */
    rotate(revokeOld = true) {
      const next = newKey();
      state.keys = revokeOld ? [next.publicKey] : [...state.keys, next.publicKey];
      state.pem = next.pem;
      return next.pem;
    },
    /** A manifest flow's one-use code, as GitHub puts it on the redirect. */
    manifestCode() {
      const code = `code_${randomBytes(8).toString("hex")}`;
      state.manifests.set(code, { used: false });
      return code;
    },
    /** Tokens minted, in order: what each reaches, never compared by value in a response. */
    minted: () => state.issued.map(({ token: _token, ...rest }) => rest),
  };
}
export type FakeGitHubApp = Awaited<ReturnType<typeof fakeGitHubApp>>;

/** An OpenAPI document for the fake's `GET /repos/{owner}/{repo}`, as an OpenAPI source of a definition takes it. */
export const REPOS_SPEC = {
  openapi: "3.0.0", info: { title: "GitHub", version: "1" },
  paths: { "/repos/{owner}/{repo}": { get: { operationId: "getRepo", summary: "A repository", parameters: [
    { name: "owner", in: "path", required: true, schema: { type: "string" } },
    { name: "repo", in: "path", required: true, schema: { type: "string" } },
  ], responses: { 200: { description: "The repository" } } } } },
};
