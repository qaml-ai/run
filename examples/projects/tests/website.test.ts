import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { serveTools } from "@camelai/run/server";
import { testRuntime } from "@camelai/run/testing";
import { Projects } from "../lib/projects.ts";
import { Versions } from "../lib/versions.ts";
import { validateSite } from "../website/validate.ts";
import { fakeRuntime, files } from "./fixtures.ts";

const MCP = "https://app.test/mcp";

test("a site needs an index.html, and every local link and asset in it", async () => {
  assert.deepEqual((await validateSite(files({ "about.html": "<p>hi</p>" }))).problems, [{ path: "index.html", message: "Missing: the site's home page" }]);
  const { problems } = await validateSite(files({
    "index.html": `<link href="style.css" rel="stylesheet"><a href="about/">About</a><img src="/logo.png">
      <a href="https://example.com">out</a><a href="#top">top</a><img src="data:image/png;base64,AA==">`,
    "style.css": `body { background: url("img/bg.png") }`,
  }));
  assert.deepEqual(problems, [
    { path: "index.html", message: "Refers to about/, but there is no about/index.html" },
    { path: "index.html", message: "Refers to /logo.png: use a relative link (the site is served under its own path)" },
    { path: "style.css", message: "Refers to img/bg.png, but there is no img/bg.png" },
  ]);
  assert.deepEqual((await validateSite(files({ "index.html": `<a href="docs/a.html">a</a>`, "docs/a.html": `<a href="../index.html?x=1">home</a>` }))).problems, []);
});

test("publish reads the project from the identity token, refuses problems, and stores immutable versions", async () => {
  const runtime = await testRuntime();
  const fake = await fakeRuntime("site", { alpha: files({ "index.html": `<link href="style.css" rel="stylesheet">` }), beta: files({ "index.html": "beta" }) });
  const versions = new Versions(join(fake.dataDir, "sites"));
  const projects = new Projects({
    agents: fake.agents, kind: "site", dataDir: fake.dataDir, versions, validate: validateSite, agent: {},
    url: (project, version) => `https://app.test/sites/${project}/v/${version}/`,
  });
  const handler = serveTools(projects.tools, runtime.options);
  // A call as the runtime makes it: a token for the agent's identity, and a key of its own (a retry would reuse it).
  const publish = async (identity: Parameters<typeof runtime.request>[2]) => {
    const params = { name: "publish", arguments: {}, _meta: { "agent-runtime/idempotencyKey": crypto.randomUUID() } };
    const response = await handler(await runtime.request(MCP, { jsonrpc: "2.0", id: 1, method: "tools/call", params }, identity));
    return (await response.json() as { result: { structuredContent: unknown } }).result.structuredContent;
  };

  assert.deepEqual(await publish({ context: { project: "alpha" } }), { published: false, problems: [{ path: "index.html", message: "Refers to style.css, but there is no style.css" }] });
  fake.volumes("alpha").set("style.css", new TextEncoder().encode("body {}"));
  assert.deepEqual(await publish({ context: { project: "alpha" } }), { published: true, version: 1, url: "https://app.test/sites/alpha/v/1/" });
  fake.volumes("alpha").set("index.html", new TextEncoder().encode("<h1>two</h1>"));
  assert.deepEqual(await publish({ context: { project: "alpha" } }), { published: true, version: 2, url: "https://app.test/sites/alpha/v/2/" });

  // Version 1 is as it was published, whatever the volume holds now.
  assert.equal(new TextDecoder().decode((await versions.file("alpha", 1, "index.html"))!), `<link href="style.css" rel="stylesheet">`);
  assert.equal(new TextDecoder().decode((await versions.file("alpha", 2, "index.html"))!), "<h1>two</h1>");
  assert.equal(await versions.file("alpha", 1, "../2/version.json"), null);

  // Another project's agent publishes its own volume; an agent with no project, or another tenant's, gets nothing.
  assert.deepEqual(await publish({ context: { project: "beta" } }), { published: true, version: 1, url: "https://app.test/sites/beta/v/1/" });
  const none = await runtime.callTool(handler, MCP, "publish", {}, {});
  assert.equal(none.isError, true);
  await assert.rejects(runtime.callTool(handler, MCP, "publish", {}, { tenant: "someone-else", context: { project: "alpha" } }), /HTTP 401/);
  assert.equal((await versions.list("alpha")).length, 2);
});

test("a retried publish call gets its version back instead of a new one", async () => {
  const fake = await fakeRuntime("site", {});
  const versions = new Versions(join(fake.dataDir, "sites"));
  const first = await versions.publish("gamma", files({ "index.html": "x" }), "call-1");
  assert.deepEqual(await versions.publish("gamma", files({ "index.html": "x" }), "call-1"), first);
  const [a, b] = await Promise.all([versions.publish("gamma", files({ "index.html": "a" }), "call-2"), versions.publish("gamma", files({ "index.html": "b" }), "call-3")]);
  assert.deepEqual([a.number, b.number].sort(), [2, 3]);
});
