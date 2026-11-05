import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";

test("definition revisions, imported history, forks and hidden stateless sessions", { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  async function request(path: string, input?: unknown, method = input === undefined ? "GET" : "POST", headers: Record<string,string> = {}) {
    const response = await fetch(fixture.url + path, { method, headers: { Authorization: `Bearer ${fixture.token}`, "content-type": "application/json", ...headers }, body: input === undefined ? undefined : JSON.stringify(input) });
    const value = await response.json() as any;
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  const definition = await request("/v1/definitions", { name: "Helper", webSearch:{providers:["brave","exa"]}, systemPrompt: "Reply simply.", fileTools: false, codeMode: false }, "POST", { "Idempotency-Key": "helper" });
  assert.equal(definition.revision, 1);
  assert.equal((await request("/v1/definitions/helper")).id, definition.id);
  const revised = await request(`/v1/definitions/${definition.id}`, { revision: 1, systemPrompt: "Reply briefly." }, "PATCH");
  assert.equal(revised.revision, 2);
  const agent = await request("/v1/agents", { definition: "helper", importMessages: { format: "openai-chat", messages: [{role:"user",content:"My name is Ada."}] } }, "POST", { "Idempotency-Key": "imported" });
  assert.deepEqual((await request(`/v1/agents/${agent.id}/configuration`)).webSearch,{providers:["brave","exa"]});
  assert.equal((await request(`/v1/agents/${agent.id}/history`)).messages[0].content, "My name is Ada.");
  const write = await fetch(fixture.url + `/v1/agents/${agent.id}/files/workspace/note.txt`, {method:"PUT",headers:{Authorization:`Bearer ${fixture.token}`,"content-type":"text/plain"},body:"Before fork"});
  assert.equal(write.status,201);
  const own = await request("/v1/agents", { definition: "helper", maxOutputTokens: 150 }, "POST", { "Idempotency-Key": "own-override" });
  const configured = await request("/v1/agents", { definition: "helper" }, "POST", { "Idempotency-Key": "later-override" });
  await request(`/v1/agents/${configured.id}/configuration`, { maxOutputTokens:175 }, "PATCH");
  const credentialPatch=await fetch(fixture.url+`/v1/agents/${configured.id}/configuration`,{method:"PATCH",headers:{Authorization:`Bearer ${fixture.token}`,"content-type":"application/json"},body:JSON.stringify({mcpServers:[{name:"private",url:"http://127.0.0.1:9/mcp",auth:{type:"bearer",token:"local-test-not-a-real-credential"}}]})});
  assert.equal(credentialPatch.status,400,"agent updates cannot bypass definition credential sealing");
  const applied = await request(`/v1/definitions/${definition.id}`, { revision: 2, maxOutputTokens: 200, apply: "all" }, "PATCH");
  assert.ok(applied.applied.every((item:any) => item.status === "updated"));
  assert.equal((await request(`/v1/agents/${agent.id}/configuration`)).maxOutputTokens, 200);
  assert.equal((await request(`/v1/agents/${own.id}/configuration`)).maxOutputTokens, 150);
  assert.equal((await request(`/v1/agents/${configured.id}/configuration`)).maxOutputTokens, 175);
  const fork = await request(`/v1/agents/${agent.id}/fork`, { key:"forked", atMessage:0 });
  assert.equal(fork.forkedFrom.agentId, agent.id);
  const cloned = await fetch(fixture.url + `/v1/agents/${fork.id}/files/workspace/note.txt`, {headers:{Authorization:`Bearer ${fixture.token}`}});
  assert.equal(await cloned.text(),"Before fork");
  await fetch(fixture.url + `/v1/agents/${fork.id}/files/workspace/note.txt`, {method:"PUT",headers:{Authorization:`Bearer ${fixture.token}`,"content-type":"text/plain"},body:"After fork"});
  const original = await fetch(fixture.url + `/v1/agents/${agent.id}/files/workspace/note.txt`, {headers:{Authorization:`Bearer ${fixture.token}`}});
  assert.equal(await original.text(),"Before fork");


  assert.equal((await request(`/v1/agents/${fork.id}/history`)).messages.length, 1);
  assert.equal((await request(`/v1/agents/${agent.id}/fork`, { key:"forked", atMessage:0 })).id, fork.id);
  const run = await request("/v1/runs", { input: "once", wait:true }, "POST", { "Idempotency-Key":"once" });
  assert.equal(run.status, "completed");
  assert.equal(run.text, "Echo: once");
  assert.match(run.id, /^run_/);
  assert.equal((await request("/v1/runs", {input:"once",wait:true}, "POST", {"Idempotency-Key":"once"})).id, run.id);
  assert.equal((await request(`/v1/runs/${run.id}`)).text, run.text);
  assert.deepEqual((await request(`/v1/runs/${run.id}/messages`)).messages.map((message:any) => message.role), ["user","assistant"]);
  assert.equal((await request("/v1/agents")).some((entry:any) => entry.type === "run"), false);
  const conflict = await fetch(fixture.url + "/v1/runs", {method:"POST",headers:{Authorization:`Bearer ${fixture.token}`,"content-type":"application/json","Idempotency-Key":"once"},body:JSON.stringify({input:"different"})});
  assert.equal(conflict.status,409);
  await request(`/v1/definitions/${definition.id}`, undefined, "DELETE");
});

test("forks isolate a relocated private workspace, retain shared mounts, and preserve no workspace", { timeout: 180000 }, async t => {
  const f = await startFixture();
  t.after(() => f.stop());
  const call = (path: string, options: RequestInit = {}) => fetch(f.url + path, {
    ...options, headers: { authorization: `Bearer ${f.token}`, ...options.headers },
  });
  async function json(path: string, input?: unknown) {
    const response = await call(path, input === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    const value = await response.json() as any;
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  const shared = await json("/v1/volumes", { name: "shared" });
  const sharedMount = { volumeId: shared.id, path: "/shared", subpath: "/docs", mode: "ro", notify: true };
  const source = await json("/v1/agents", { mounts: [{ workspace: true, path: "/private" }, sharedMount] });
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 37, 0xa5);
  const write = await call(`/v1/agents/${source.id}/files/private/bytes.bin`, {
    method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes,
  });
  assert.equal(write.status, 201, await write.text());
  const fork = await json(`/v1/agents/${source.id}/fork`, { key: "relocated-fork" });
  const before = await json(`/v1/agents/${source.id}/mounts`);
  const after = await json(`/v1/agents/${fork.id}/mounts`);
  assert.equal(after.length, 2, "a relocated workspace must not introduce /workspace");
  assert.deepEqual(after.find((mount: any) => mount.path === "/shared"), sharedMount);
  assert.notEqual(after.find((mount: any) => mount.path === "/private").volumeId, before.find((mount: any) => mount.path === "/private").volumeId);
  const clone = await call(`/v1/agents/${fork.id}/files/private/bytes.bin`);
  assert.equal(clone.status, 200);
  assert.deepEqual(Buffer.from(await clone.arrayBuffer()), bytes, "multipart copy preserves all bytes");
  const edit = await call(`/v1/agents/${fork.id}/files/private/bytes.bin`, { method: "PUT", body: "fork only" });
  assert.equal(edit.status, 201);
  assert.deepEqual(Buffer.from(await (await call(`/v1/agents/${source.id}/files/private/bytes.bin`)).arrayBuffer()), bytes);

  const absent = await json("/v1/agents", { mounts: [{ workspace: false }, sharedMount] });
  const absentFork = await json(`/v1/agents/${absent.id}/fork`, {});
  assert.deepEqual(await json(`/v1/agents/${absentFork.id}/mounts`), [sharedMount]);
  const privateVolume = (await f.db.query("select count(*)::int n from volumes where name='workspace'")).rows[0].n;
  assert.equal(privateVolume, 2, "neither source without a workspace nor its fork creates one");
});
