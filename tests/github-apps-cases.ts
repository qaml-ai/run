import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { fakeGitHubApp, REPOS_SPEC, WEBHOOK_SECRET, type FakeGitHubApp } from "./github-app-fake.ts";

/**
 * GitHub App cases through the public API, the same on every backend: tests/github-apps.test.ts runs them on the Node
 * runtime, tests/contract/areas/github-apps.ported.test.ts on Node and Workers. A fake GitHub (github-app-fake.ts)
 * stands in for GitHub; the scripted model calls the agent's tools.
 */

type T = { after(fn: () => Promise<void> | void): void };
type Reply = { status: number; json: any; text: string };
export type Runtime = {
  base: string;
  call(path: string, init?: { method?: string; body?: unknown; token?: string | null }): Promise<Reply>;
  prompt(agent: string, text: string, token?: string): Promise<any>;
  model: { bodies: any[] };
  logs: string[];
  /** A read of the github_apps table, where the backend's fixture offers one. */
  query?(text: string): Promise<{ rows: any[] }>;
};
/** Starts a runtime whose model answers with `respond`, with `env`. */
export type Start = (t: T, respond: (body: any, index: number) => object, env: Record<string, string>) => Promise<Runtime>;

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const toolCall = (name: string, args: unknown, id = `call_${randomUUID().slice(0, 8)}`) => ({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const toolResults = (body: any): string[] => body.messages.filter((message: any) => message.role === "tool").map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""));
const done = { role: "assistant", content: "done" };

/** A runtime pointed at a fake GitHub, whose model's replies the case sets as it goes (`script`). */
async function setup(t: T, start: Start, env: Record<string, string> = {}) {
  const github = await fakeGitHubApp(t);
  let replies: object[] = [];
  let next = 0;
  const r = await start(t, () => replies[next++] ?? done, { ...LOCAL, AGENT_GITHUB_API_URL: github.url, ...env });
  /** The model's next replies: each tool call in turn, then "done". */
  const script = (...steps: object[]) => { replies = steps; next = 0; };
  return { r, github, script };
}

const createApp = async (r: Runtime, github: FakeGitHubApp, fields: Record<string, unknown> = {}, token?: string) => {
  const created = await r.call("/v1/github-apps", { body: { appId: "5151", privateKey: github.state.pem, name: "code", ...fields }, ...(token ? { token } : {}) });
  assert.equal(created.status, 201, created.text);
  return created.json;
};
const reposSource = (github: FakeGitHubApp, auth: Record<string, unknown> = {}) => ({
  name: "github", spec: REPOS_SPEC, baseUrl: github.url,
  auth: { type: "github-app", app: "code", repositories: ["acme/app"], permissions: { contents: "read", metadata: "read" }, ...auth },
});
const noSecrets = (text: string, github: FakeGitHubApp) => {
  for (const issued of github.state.issued) assert.ok(!text.includes(issued.token), "no installation token is shown");
  assert.doesNotMatch(text, /ghs_|PRIVATE KEY/);
};

export const cases: Record<string, (t: T, start: Start) => Promise<void>> = {
  "repository listing pages across installations and access uses stored read-only credentials": async (t, start) => {
    const { r, github } = await setup(t, start);
    await createApp(r, github);
    for (const path of ["/v1/github-apps/code/repositories", "/v1/github-apps/code/repositories/acme/app"]) {
      assert.equal((await r.call(path, { token: "other-operator-token-at-least-24-chars" })).status, 404);
    }
    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await r.call("/v1/github-apps/code/repositories?perPage=1" + (cursor ? "&cursor=" + cursor : ""));
      assert.equal(page.status, 200, page.text);
      noSecrets(page.text, github);
      assert.ok(!page.text.includes("must-not-return"));
      names.push(...page.json.items.map((repo: any) => repo.fullName));
      cursor = page.json.nextCursor;
    } while (cursor);
    assert.deepEqual(names, ["acme/app", "acme/other", "solo/tool"]);
    const check = await r.call("/v1/github-apps/code/repositories/acme/app");
    assert.equal(check.status, 200, check.text);
    assert.equal(check.json.fullName, "acme/app");
    assert.equal((await r.call("/v1/github-apps/code/repositories/acme/missing")).status, 404);
    assert.equal((await r.call("/v1/github-apps/code/repositories?cursor=invalid")).status, 400);
    assert.equal((await r.call("/v1/github-apps/code/repositories?perPage=101")).status, 400);
    assert.ok(github.minted().every(token => JSON.stringify(token.permissions) === JSON.stringify({ metadata: "read" })));
  },
  "an App is checked with GitHub, kept sealed and shown masked; it is renamed, its key rotated, and deleted": async (t, start) => {
    const { r, github } = await setup(t, start);
    const refused = async (body: unknown, status: number, message: RegExp, method = "POST", path = "/v1/github-apps") => {
      const answer = await r.call(path, { method, body });
      assert.equal(answer.status, status, answer.text);
      assert.match(answer.json.error, message);
      noSecrets(answer.text, github);
    };
    await refused({ appId: "5151", privateKey: "nope" }, 400, /privateKey is a private key generated for the App/);
    await refused({ appId: "x5151", privateKey: github.state.pem }, 400, /appId is the App ID/);
    await refused({ appId: "1", privateKey: github.state.pem }, 422, /GitHub rejected the App's credentials/);
    await refused({ appId: "5151", privateKey: github.state.pem, clientSecret: "x" }, 400, /Unknown field clientSecret/);
    await refused({ appId: "5151", privateKey: github.state.pem, name: "gha_0123456789abcdef0123" }, 400, /name is 1–100 letters/);

    const app = await createApp(r, github);
    assert.match(app.id, /^gha_[a-f0-9]{20}$/);
    assert.deepEqual({ ...app, id: undefined, masked: undefined, createdAt: undefined, updatedAt: undefined },
      { id: undefined, name: "code", appId: "5151", slug: "camel-code", owner: "acme", htmlUrl: "https://github.com/apps/camel-code", masked: undefined, createdAt: undefined, updatedAt: undefined });
    assert.match(app.masked.privateKey, /^….{10}…$/);
    assert.equal(app.masked.webhookSecret, undefined);
    assert.ok(github.state.requests.some(request => request.path === "/app" && request.jwt), "the key was checked with a JWT it signed");
    await refused({ appId: "5151", privateKey: github.state.pem, name: "code" }, 409, /A GitHub App named code exists/);

    const listed = await r.call("/v1/github-apps");
    assert.deepEqual(listed.json.map((entry: any) => entry.id), [app.id]);
    assert.equal((await r.call(`/v1/github-apps/${app.id}`)).json.name, "code");
    assert.equal((await r.call("/v1/github-apps/code")).json.id, app.id);
    assert.equal((await r.call(`/v1/github-apps/${app.id}`, { token: "other-operator-token-at-least-24-chars" })).status, 404, "another tenant's App is not found");
    noSecrets(listed.text, github);
    if (r.query) {
      const stored = JSON.stringify((await r.query("select app from github_apps")).rows);
      assert.doesNotMatch(stored, /PRIVATE KEY/, "the key is stored sealed");
      assert.ok(stored.includes(app.id));
    }

    // Rotation: the new key is checked first; the old one, deleted at GitHub, no longer goes.
    const old = github.state.pem;
    const pem = github.rotate();
    const rotated = await r.call(`/v1/github-apps/${app.id}`, { method: "PATCH", body: { privateKey: pem, webhookSecret: "hook-secret-9876" } });
    assert.equal(rotated.status, 200, rotated.text);
    assert.notEqual(rotated.json.masked.privateKey, app.masked.privateKey);
    assert.equal(rotated.json.masked.webhookSecret, "…9876");
    assert.equal(typeof rotated.json.keyRotatedAt, "number");
    await refused({ privateKey: old }, 422, /GitHub rejected the App's credentials/, "PATCH", `/v1/github-apps/${app.id}`);
    await refused({ appId: "1" }, 400, /appId cannot change/, "PATCH", `/v1/github-apps/${app.id}`);
    await refused({ hosts: ["https://mcp.example.com/x"] }, 400, /hosts is a list of at most 20 host names/, "PATCH", `/v1/github-apps/${app.id}`);
    const renamed = await r.call(`/v1/github-apps/${app.id}`, { method: "PATCH", body: { name: "camel", webhookSecret: null, hosts: ["mcp.example.com"] } });
    assert.deepEqual([renamed.status, renamed.json.name, renamed.json.masked.webhookSecret, renamed.json.hosts], [200, "camel", undefined, ["mcp.example.com"]]);
    noSecrets(renamed.text + rotated.text, github);

    assert.deepEqual((await r.call(`/v1/github-apps/${app.id}`, { method: "DELETE" })).json, { deleted: true });
    assert.equal((await r.call(`/v1/github-apps/${app.id}`)).status, 404);
    assert.deepEqual((await r.call("/v1/github-apps")).json, []);
  },

  "a definition's OpenAPI source gets an installation token the runtime mints, scoped to its repositories and permissions, and never shown": async (t, start) => {
    const { r, github, script } = await setup(t, start);
    await createApp(r, github);
    const refused = async (auth: Record<string, unknown>, message: RegExp) => {
      const answer = await r.call("/v1/definitions", { body: { name: "Bad", openApi: [reposSource(github, auth)] } });
      assert.equal(answer.status, 400, answer.text);
      assert.match(answer.json.error, message);
    };
    await refused({ repositories: ["acme/app", "solo/tool"] }, /repositories must all have one owner/);
    await refused({ repositories: ["app"] }, /is not owner\/name/);
    await refused({ permissions: { contents: "own" } }, /permissions\.contents must be "read", "write" or "admin"/);
    await refused({ app: "not a name!" }, /auth\.app is the name or id/);
    await refused({ token: "x" }, /Unrecognized key: "token"/);

    const saved = await r.call("/v1/definitions", { body: { name: "Reader", openApi: [reposSource(github)] } });
    assert.equal(saved.status, 201, saved.text);
    assert.deepEqual(saved.json.openApi[0].auth, { type: "github-app", app: "code", repositories: ["acme/app"], permissions: { contents: "read", metadata: "read" } });
    const agent = (await r.call("/v1/agents", { body: { definition: saved.json.id } })).json;

    script(toolCall("github__getRepo", { owner: "acme", repo: "app" }), toolCall("github__getRepo", { owner: "acme", repo: "other" }));
    const record = await r.prompt(agent.id, "read both");
    assert.equal(record.outcome.result.reply, "done");
    const [allowed, denied] = toolResults(r.model.bodies.at(-1));
    assert.match(allowed!, /"full_name":\s*"acme\/app"/);
    assert.match(denied!, /answered HTTP 404/, "the token reaches only the repositories the definition names");
    const minted = github.minted();
    assert.equal(minted.length, 1, "one token for both calls");
    assert.deepEqual([minted[0]!.installation, minted[0]!.repositories, minted[0]!.permissions], [101, ["app"], { contents: "read", metadata: "read" }]);
    assert.ok(github.state.requests.some(request => request.path === "/repos/acme/app/installation" && request.jwt), "the installation was found by the repository");

    // A grant for the other repository gets a token of its own, which reaches it.
    const other = await r.call("/v1/definitions", { body: { name: "Other", openApi: [reposSource(github, { repositories: ["acme/other"] })] } });
    const second = (await r.call("/v1/agents", { body: { definition: other.json.id } })).json;
    script(toolCall("github__getRepo", { owner: "acme", repo: "other" }));
    await r.prompt(second.id, "read the other");
    assert.match(toolResults(r.model.bodies.at(-1))[0]!, /"full_name":\s*"acme\/other"/);
    assert.deepEqual(github.minted().map(entry => entry.repositories), [["app"], ["other"]]);

    // Nothing a caller, the model or an operator reads holds a token.
    const visible = [saved.text, other.text, JSON.stringify(record), JSON.stringify(r.model.bodies),
      (await r.call(`/v1/agents/${agent.id}`)).text, (await r.call(`/v1/agents/${agent.id}/history`)).text, (await r.call("/v1/definitions")).text].join("\n");
    noSecrets(visible, github);
    noSecrets(r.logs.join("\n"), github);
  },

  "a rotated key mints new tokens, a deleted App mints none, and another tenant's App is never used": async (t, start) => {
    const { r, github, script } = await setup(t, start);
    const app = await createApp(r, github);
    const definition = (await r.call("/v1/definitions", { body: { name: "Reader", openApi: [reposSource(github)] } })).json;
    const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json;
    const read = async (id = agent.id, token?: string) => {
      script(toolCall("github__getRepo", { owner: "acme", repo: "app" }));
      await r.prompt(id, "read it", token);
      return toolResults(r.model.bodies.at(-1)).at(-1)!;
    };
    assert.match(await read(), /"full_name":\s*"acme\/app"/);
    assert.equal(github.minted().length, 1);

    // The App's key rotated (the old one deleted at GitHub): the next call mints with the new one.
    const pem = github.rotate();
    assert.equal((await r.call(`/v1/github-apps/${app.id}`, { method: "PATCH", body: { privateKey: pem } })).status, 200);
    assert.match(await read(), /"full_name":\s*"acme\/app"/);
    assert.equal(github.minted().length, 2, "a token minted under the old key is not reused");
    assert.equal(github.state.requests.filter(request => request.path.endsWith("/access_tokens")).at(-1)!.jwt, true, "signed with the new key");

    // Bob names alice's App: his tenant has none of that name.
    const other = "other-operator-token-at-least-24-chars";
    const bobs = await r.call("/v1/definitions", { body: { name: "Borrow", openApi: [reposSource(github)] }, token: other });
    assert.equal(bobs.status, 201, bobs.text);
    const bob = (await r.call("/v1/agents", { body: { definition: bobs.json.id }, token: other })).json;
    assert.match(await read(bob.id, other), /GitHub App code is not one of this tenant's/);
    assert.equal(github.minted().length, 2);

    // Deleted: no token is minted or served from it again.
    assert.equal((await r.call(`/v1/github-apps/${app.id}`, { method: "DELETE" })).status, 200);
    assert.match(await read(), /GitHub App code is not one of this tenant's/);
    assert.equal(github.minted().length, 2);
    noSecrets(JSON.stringify(r.model.bodies) + r.logs.join("\n"), github);
  },

  "an MCP server with auth github-app: saving lists its tools with a minted token, and its calls carry one": async (t, start) => {
    const { r, github, script } = await setup(t, start);
    const seen: { reached: boolean }[] = [];
    const server = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const issued = github.tokenFor(req.headers.authorization);
      seen.push({ reached: github.reaches(issued, "acme", "app") });
      if (!issued) { res.writeHead(401).end(); return; }
      const mcp = new McpServer({ name: "github", version: "1.0.0" });
      mcp.registerTool("repo", { description: "Which repository the token reaches", inputSchema: { name: z.string() } }, async ({ name }) =>
        ({ content: [{ type: "text", text: github.reaches(issued, "acme", name) ? `token reaches acme/${name}` : `token does not reach acme/${name}` }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, text ? JSON.parse(text) : undefined);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    const mcpServers = [{ name: "gh", url, auth: { type: "github-app", app: "code", repositories: ["acme/app"] } }];

    const missing = await r.call("/v1/definitions", { body: { name: "Missing", mcpServers } });
    assert.equal(missing.status, 400, missing.text);
    assert.match(missing.json.error, /GitHub App code is not one of this tenant's/);
    await createApp(r, github);
    const saved = await r.call("/v1/definitions", { body: { name: "Tools", mcpServers } });
    assert.equal(saved.status, 201, saved.text);
    assert.deepEqual(saved.json.mcpServers[0].auth, { type: "github-app", app: "code", repositories: ["acme/app"] });
    assert.ok(seen.length && seen.every(entry => entry.reached), "the listing carried a token for the repository");
    const agent = (await r.call("/v1/agents", { body: { definition: saved.json.id } })).json;
    script(toolCall("gh__repo", { name: "app" }), toolCall("gh__repo", { name: "other" }));
    await r.prompt(agent.id, "check");
    const results = toolResults(r.model.bodies.at(-1));
    assert.match(results[0]!, /token reaches acme\/app/);
    assert.match(results[1]!, /token does not reach acme\/other/);
    noSecrets(saved.text + JSON.stringify(r.model.bodies) + r.logs.join("\n"), github);
  },

  "a manifest code becomes a stored App with its webhook secret, once": async (t, start) => {
    const { r, github } = await setup(t, start);
    const code = github.manifestCode();
    const made = await r.call("/v1/github-apps/manifest", { body: { code } });
    assert.equal(made.status, 201, made.text);
    assert.deepEqual([made.json.name, made.json.appId, made.json.slug, made.json.owner, made.json.masked.webhookSecret], ["camel-code", "5151", "camel-code", "acme", `…${WEBHOOK_SECRET.slice(-4)}`]);
    assert.doesNotMatch(made.text, /fixture-client-secret|PRIVATE KEY/);
    const again = await r.call("/v1/github-apps/manifest", { body: { code, name: "again" } });
    assert.equal(again.status, 404, again.text);
    assert.match(again.json.error, /GitHub answered HTTP 404/);
    assert.equal((await r.call("/v1/github-apps/manifest", { body: { code: "bad code!" } })).status, 400);
    assert.equal((await r.call("/v1/github-apps")).json.length, 1);
  },

  "a GitHub channel can use a stored App's credentials, and the App is not deleted while it does": async (t, start) => {
    const { r, github } = await setup(t, start);
    const app = (await r.call("/v1/github-apps/manifest", { body: { code: github.manifestCode() } })).json;
    const both = await r.call("/v1/channels", { body: { type: "github", credentials: { app: "camel-code", appId: "5151" } } });
    assert.equal(both.status, 400, both.text);
    const unknown = await r.call("/v1/channels", { body: { type: "github", credentials: { app: "nope" } } });
    assert.equal(unknown.status, 400, unknown.text);
    assert.match(unknown.json.error, /credentials\.app: Unknown GitHub App nope/);
    const created = await r.call("/v1/channels", { body: { type: "github", credentials: { app: "camel-code" } } });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.account.githubApp, app.id);
    assert.equal(created.json.account.slug, "camel-code");
    assert.deepEqual(created.json.credentials, { app: "camel-code", appId: "5151" });
    noSecrets(created.text, github);

    // Deliveries are verified with the App's webhook secret.
    const deliver = (secret: string) => {
      const body = JSON.stringify({ zen: "Design for failure.", hook_id: 1 });
      return fetch(`${r.base}/channels/github/${created.json.id}`, { method: "POST", body, headers: {
        "Content-Type": "application/json", "X-GitHub-Event": "ping", "X-GitHub-Delivery": randomUUID(),
        "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      } });
    };
    assert.equal((await deliver(WEBHOOK_SECRET)).status, 200);
    assert.equal((await deliver("wrong")).status, 401);

    const blocked = await r.call(`/v1/github-apps/${app.id}`, { method: "DELETE" });
    assert.equal(blocked.status, 409, blocked.text);
    assert.match(blocked.json.error, new RegExp(`Channel ${created.json.id} uses this GitHub App`));
    assert.equal((await r.call(`/v1/channels/${created.json.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await r.call(`/v1/github-apps/${app.id}`, { method: "DELETE" })).status, 200);
  },
};
