import assert from "node:assert/strict";
import test from "node:test";
import { fakeModel, lastUser, toolCall } from "../../../tests/runtime-server.ts";
import { startFixture } from "./fixture.ts";

test("file tools retain read versions through reopen and guard writes by volume and canonical path", { timeout: 90_000 }, async t => {
  const model = await fakeModel(t, body => {
    const latestUser = body.messages.findLastIndex((message: any) => message.role === "user");
    const returned = body.messages.slice(latestUser + 1).findLast((message: any) => message.role === "tool");
    if (returned) return { role: "assistant", content: returned.content };
    const call = JSON.parse(lastUser(body));
    return toolCall(call.name, call.args, `call_${crypto.randomUUID()}`);
  });
  const f = await startFixture({ modelURL: model.url });
  t.after(() => f.stop());
  const call = async (path: string, options: { method?: string; body?: unknown; raw?: string; key?: string } = {}) => {
    const response = await fetch(f.url + path, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${f.token}`, "content-type": options.raw === undefined ? "application/json" : "text/plain", ...(options.key ? { "idempotency-key": options.key } : {}) },
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
    const text = await response.text();
    let result: any = text;
    try { result = JSON.parse(text); } catch {}
    assert.ok(response.ok, `${response.status}: ${text}`);
    return result;
  };
  const volume = await call("/v1/volumes", { body: {} });
  const file = `/v1/volumes/${volume.id}/files/team/plan.txt`;
  await call(file, { method: "PUT", raw: "original" });
  const mounts = [
    { volumeId: volume.id, path: "/project", subpath: "/team", mode: "rw" },
    { volumeId: volume.id, path: "/mirror", subpath: "/team", mode: "rw" },
    { workspace: false },
  ];
  const agent = await call("/v1/agents", { key: "file-versions", body: { mounts } });
  const run = async (name: string, args: unknown) => {
    const request = await call(`/v1/agents/${agent.id}/prompt`, { body: { text: JSON.stringify({ name, args }) } });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const settled = await call(`/v1/agents/${agent.id}/requests/${request.id}?wait=1`);
      if (settled.state === "completed") {
        assert.ok(settled.outcome.result, JSON.stringify(settled));
        return settled.outcome.result.reply as string;
      }
    }
    throw new Error("File tool did not finish");
  };

  assert.equal(await run("read", { path: "/project/plan.txt" }), "original");
  await call(file, { method: "PUT", raw: "external change" });
  await f.worker.stop(true);
  await f.worker.start();
  const stale = await run("write", { path: "/mirror/plan.txt", content: "stale overwrite" });
  assert.match(stale, /\/mirror\/plan\.txt changed since you last read it; read it again/);
  assert.equal(await call(file), "external change");

  // A harmless upsert keeps both the mounts and the agent's remembered version.
  await call("/v1/agents", { key: "file-versions", body: { name: "renamed" } });
  assert.match(await run("write", { path: "plan.txt", content: "still stale" }), /changed since you last read it/);
  assert.equal(await run("read", { path: "plan.txt" }), "external change");
  assert.doesNotMatch(await run("write", { path: "plan.txt", content: "ours" }), /changed since you last read it/);
  assert.equal(await call(file), "ours");
  await call(file, { method: "PUT", raw: "external again" });
  assert.match(await run("edit", { path: "/mirror/plan.txt", edits: [{ oldText: "external", newText: "bad" }] }), /changed since you last read it/);
  assert.equal(await call(file), "external again");
  await run("read", { path: "/project/plan.txt" });
  await run("edit", { path: "/project/plan.txt", edits: [{ oldText: "external", newText: "ours" }] });
  await run("edit", { path: "/mirror/plan.txt", edits: [{ oldText: "again", newText: "twice" }] });
  assert.equal(await call(file), "ours twice", "the agent's own edits refresh its version");
  await run("write", { path: "new.txt", content: "created without a read" });
  await run("write", { path: "new.txt", content: "updated without a read" });
  assert.equal(await call(`/v1/volumes/${volume.id}/files/team/new.txt`), "updated without a read");

  const other = await call("/v1/volumes", { body: {} });
  await call(`/v1/volumes/${other.id}/files/team/plan.txt`, { method: "PUT", raw: "other volume" });
  await call(`/v1/agents/${agent.id}/mounts`, { method: "PUT", body: { mounts: [{ volumeId: other.id, path: "/project", subpath: "/team", mode: "rw" }, { workspace: false }] } });
  await run("write", { path: "plan.txt", content: "different identity" });
  assert.equal(await call(`/v1/volumes/${other.id}/files/team/plan.txt`), "different identity", "the same shown path in another volume has its own version");
});
