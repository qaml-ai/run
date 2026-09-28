import { test } from "node:test";
import assert from "node:assert/strict";
import { OTHER_OPERATOR, runtime } from "./runtime-server.ts";

test("a tenant signs links to its agent's files with its own token, as for its volumes", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  // Links name the runtime's public URL; the test reaches it here.
  const local = (url: string) => `${r.base}${new URL(url).pathname}`;
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const upload = await fetch(`${r.base}/v1/agents/${agent}/uploads/r1/notes.txt`, { method: "PUT", headers: { Authorization: "Bearer fixture-operator-token-at-least-24-chars", "Content-Type": "text/plain" }, body: "hello" });
  assert.equal(upload.status, 201, await upload.clone().text());
  const path = (await upload.json() as any).path;

  const link = await r.call(`/v1/agents/${agent}/links`, { body: { path, expiresIn: 120 } });
  assert.equal(link.status, 201, link.text);
  assert.equal(link.json.path, path, "the path as the agent sees it");
  assert.ok(link.json.expiresAt - Date.now() <= 120_000);
  assert.equal(await (await fetch(local(link.json.url))).text(), "hello", "the link works with no token");

  const put = await r.call(`/v1/agents/${agent}/links`, { body: { path: "/workspace/out/report.txt", method: "PUT", contentType: "text/plain" } });
  assert.equal(put.status, 201, put.text);
  assert.equal((await fetch(local(put.json.url), { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "written" })).status, 201);
  const read = await r.call(`/v1/agents/${agent}/links`, { body: { path: "/workspace/out/report.txt" } });
  assert.equal(await (await fetch(local(read.json.url))).text(), "written");

  assert.equal((await r.call(`/v1/agents/${agent}/links`, { body: { path: "/etc/passwd" } })).status, 400, "only a path in its mounts");
  assert.equal((await r.call(`/v1/agents/${agent}/links`, { body: { path, expiresIn: 999_999 } })).status, 400);
  assert.equal((await r.call(`/v1/agents/${agent}/links`, { body: { path }, token: OTHER_OPERATOR })).status, 404, "another tenant's agent is not found");
});
