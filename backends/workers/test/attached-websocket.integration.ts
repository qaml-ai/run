import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime, tool, schema } from "../../../clients/typescript.ts";
import { startFixture } from "./fixture.ts";

test("WebSocket attachments initialize, survive idle, enforce ownership and release on close", { timeout: 60_000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  let calls = 0;
  const tools = { echo: tool({ description: "Echo", input: schema.Object({ value: schema.String() }), execute: ({ value }) => { calls++; return value; } }) };
  const runtime = new AgentRuntime({ url: fixture.url, apiKey: fixture.token });
  const owner = await runtime.createAgent({ tools, model: "test/echo", fileTools: false });
  t.after(() => owner.close());
  assert.deepEqual((await owner.execute('return await tools.echo({value:"first"})')).output, ["first"]);
  await assert.rejects(runtime.connectAgent(owner.session, { tools }), (error: any) => error.code === "APPLICATION_CONNECTED");
  // Hibernatable sockets can go quiet without a heartbeat or a fresh handshake.
  // The next host request may overlap startup restoring its durable intent;
  // observer initialization must not make startup wait on itself.
  await new Promise(resolve => setTimeout(resolve, 12_000));
  assert.deepEqual((await owner.execute('return await tools.echo({value:"after idle"})')).output, ["after idle"]);
  await owner.close();
  const next = await runtime.connectAgent(owner.session, { tools });
  t.after(() => next.close());
  assert.deepEqual((await next.execute('return await tools.echo({value:"new owner"})')).output, ["new owner"]);
  assert.equal(calls, 3);
});
