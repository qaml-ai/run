import { serveFakeCamelfsd } from "./fake-camelfsd.ts";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";

test("definition revisions, imported history, forks and hidden stateless sessions", { timeout: 180000 }, async t => {
  const fixture = await repoFixture(t);
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
  const f = await repoFixture(t);
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
  const shared = await json("/v1/repos", { name: "shared" });
  await call(`/v1/repos/${shared.id}/commit`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({files:{"docs/initial.txt":{text:"initial"}}})});
  const sharedMount = { repo: shared.id, path: "/shared", subpath: "/docs", mode: "ro", notify: true, ref: "main" };
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
  assert.notEqual(after.find((mount: any) => mount.path === "/private").repo, before.find((mount: any) => mount.path === "/private").repo);
  const clone = await call(`/v1/agents/${fork.id}/files/private/bytes.bin`);
  assert.equal(clone.status, 200);
  assert.deepEqual(Buffer.from(await clone.arrayBuffer()), bytes, "multipart copy preserves all bytes");
  const edit = await call(`/v1/agents/${fork.id}/files/private/bytes.bin`, { method: "PUT", body: "fork only" });
  assert.equal(edit.status, 201);
  assert.deepEqual(Buffer.from(await (await call(`/v1/agents/${source.id}/files/private/bytes.bin`)).arrayBuffer()), bytes);

  const absent = await json("/v1/agents", { mounts: [{ workspace: false }, sharedMount] });
  const absentFork = await json(`/v1/agents/${absent.id}/fork`, {});
  assert.deepEqual(await json(`/v1/agents/${absentFork.id}/mounts`), [sharedMount]);
  const privateVolume = (await json("/v1/repos")).repos.filter((r:any)=>r.key?.startsWith("agent:")).length;
  assert.equal(privateVolume, 2, "neither source without a workspace nor its fork creates one");
});

test("fork retries resume the claimed history and file versions after interruption", { timeout: 180000 }, async t => {
  const f = await repoFixture(t);
  t.after(() => f.stop());
  const call = (path: string, options: RequestInit = {}) => fetch(f.url + path, {
    ...options, headers: { authorization: `Bearer ${f.token}`, ...options.headers },
  });
  async function json(path: string, value?: unknown, extra: Record<string, string> = {}) {
    const response = await call(path, value === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(value),
    });
    const body = await response.json() as any;
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  }
  const source = await json("/v1/agents", { initialMessages: [{ role: "user", content: "Original history" }] });
  const mounts = await json(`/v1/agents/${source.id}/mounts`), volume = mounts[0].repo;
  const write = async (name: string, value: string) => {
    const response = await call(`/v1/agents/${source.id}/files/workspace/${name}`, { method: "PUT", body: value });
    assert.equal(response.status, 201, await response.text());
  };
  const invalid = await call(`/v1/agents/${source.id}/fork`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "correct-invalid", modelHeaders: { bad: 42 } }),
  });
  assert.equal(invalid.status, 400, await invalid.text());
  assert.ok((await json(`/v1/agents/${source.id}/fork`, { key: "correct-invalid" })).id, "invalid input cannot leave a durable bad plan");
  for (const point of ["created", "copied"]) {
    await write("a.txt", `${point}: original a`);
    await write("b.txt", `${point}: original b`);
    const key = `resume-${point}`;
    const interrupted = await call(`/v1/agents/${source.id}/fork`, {
      method: "POST", headers: { "content-type": "application/json", "x-camel-test-fork-failure": point },
      body: JSON.stringify({ key, atMessage: 0 }),
    });
    assert.ok(interrupted.status >= 500, await interrupted.text());
    const pending = (await f.db.query("select header from agents where tenant=$1 and header->>'key'=$2", ["camelrun-proto-local", key])).rows[0].header;
    assert.equal(pending.forkedFrom, undefined);
    const before = point === "copied" ? await call(`/v1/agents/${pending.id}/files/workspace/a.txt`) : undefined;
    const copiedVersion = before?.headers.get("x-file-version");
    if (before) assert.equal(await before.text(), `${point}: original a`);
    await write("a.txt", `${point}: newer a`);
    await write("b.txt", `${point}: newer b`);
    const held = await json(`/v1/repos/${volume}/history?ref=main`);
    assert.ok(held.versions.length>=4,"prior versions remain reachable through repo history");
    await f.worker.stop(true);
    await f.worker.start();
    const forks = await Promise.all(Array.from({ length: 3 }, () => json(`/v1/agents/${source.id}/fork`, { key, atMessage: 0 })));
    assert.ok(forks.every(fork => fork.id === pending.id), "concurrent retries converge on one fork");
    for (const name of ["a", "b"]) {
      const response = await call(`/v1/agents/${pending.id}/files/workspace/${name}.txt`);
      assert.equal(await response.text(), `${point}: original ${name}`);
      if (name === "b") assert.match(response.headers.get("x-file-version")!, /^[a-f0-9]{40}$/, "fork files name immutable commits");
      if (name === "a" && copiedVersion) assert.equal(response.headers.get("x-file-version"), copiedVersion, "a completed file is not copied again");
    }
    assert.deepEqual((await json(`/v1/agents/${pending.id}/history`)).messages.map((message: any) => message.content), ["Original history"]);
    assert.ok((await json(`/v1/repos/${volume}/history?ref=main`)).versions.length>=held.versions.length,"fork completion retains parent history");
    assert.equal((await json(`/v1/agents/${source.id}/fork`, { key })).id, pending.id);
  }
  const expiring = await call(`/v1/agents/${source.id}/fork`, {
    method: "POST", headers: { "content-type": "application/json", "x-camel-test-fork-failure": "created", "x-camel-test-fork-short-ttl": "1" },
    body: JSON.stringify({ key: "expired-copy" }),
  });
  assert.equal(expiring.status, 503, await expiring.text());
  await write("a.txt", "after expired claim");
  await new Promise(resolve => setTimeout(resolve, 1100));
  for (let retry = 0; retry < 2; retry++) {
    const expired = await call(`/v1/agents/${source.id}/fork`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "expired-copy" }),
    });
    assert.equal(expired.status, 410);
    assert.equal((await expired.json() as any).code, "FORK_EXPIRED");
  }
  assert.ok((await json(`/v1/repos/${volume}/history?ref=main`)).versions.length,"expired claims retain immutable versions");
  const raced = await call(`/v1/agents/${source.id}/fork`, {
    method: "POST", headers: { "content-type": "application/json", "x-camel-test-fork-failure": "claimed" },
    body: JSON.stringify({ key: "ordinary-create-race" }),
  });
  assert.equal(raced.status, 503, await raced.text());
  const ordinary = await json("/v1/agents", { name: "unrelated", mounts: [{ workspace: false }] }, { "idempotency-key": "ordinary-create-race" });
  const conflict = await call(`/v1/agents/${source.id}/fork`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "ordinary-create-race" }),
  });
  assert.equal(conflict.status, 409, await conflict.text());
  assert.equal((await json(`/v1/agents/${ordinary.id}/configuration`)).name, "unrelated");
});

async function repoFixture(t:any) {
  const api=await serveFakeCamelfsd('fork-test-token');t.after(()=>api.close());
  return startFixture({camelfsStub:true,entrypoint:fileURLToPath(new URL('./camelfs-worker.ts',import.meta.url)),vars:{TEST_CAMELFS_URL:api.url,CAMELFS_API_TOKEN:'fork-test-token'}});
}
