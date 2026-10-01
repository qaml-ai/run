import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { Definitions } from "../src/definitions.ts";
import { Channels, type ChannelProvider } from "../src/channels.ts";
import { testDatabase } from "./database.ts";
import { until } from "./runtime-server.ts";

test("managed channel APIs require verified provisioning and recheck revoked sender access after awaited startup", async () => {
  const { db } = await testDatabase();
  const starting = Promise.withResolvers<void>();
  let created = false, submitted = 0;
  const provider: ChannelProvider = {
    managed: true, label: "Managed fixture", needsCredentials: false, maxMessageLength: 2000, maxFileBytes: 1024,
    setup: async () => ({ account: {}, masked: {} }), teardown: async () => {},
    guard: async () => true,
    download: async () => { throw new Error("No test files"); }, send: async () => {}, sendFile: async () => {},
  };
  const channels = new Channels({
    db, accounts: new Accounts({ db, tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), secretsKey: randomBytes(32).toString("hex") }),
    definitions: new Definitions({ db }), providers: { "discord-managed": provider }, node: "guard-test", publicUrl: "https://camel.test",
    agentId: () => "client_guard", live: async () => true,
    createAgent: async () => { created = true; await starting.promise; return { id: "client_guard" }; },
    submit: async () => { submitted++; return { id: "req", method: "prompt", state: "running", fingerprint: "" }; },
  });
  await assert.rejects(channels.create("alice", { type: "discord-managed" }), /Set up this integration/);
  const channel = await channels.create("alice", { type: "discord-managed", access: { allow: ["allowed-user"] } }, { managed: true });
  await assert.rejects(channels.update("alice", channel.id, { access: { public: true } }), /server setup/);
  await assert.rejects(channels.remove("alice", channel.id), /server setup/);
  await channels.inbound(channel.id, { conversationId: "201", messageId: "message-1", sender: { id: "allowed-user" }, text: "start", files: [] });
  await until(() => created, "agent provisioning waits");
  await channels.update("alice", channel.id, { access: { public: false, allow: [] } }, { managed: true });
  starting.resolve();
  await until(async () => !(await db.query("select 1 from channel_items where item->>'channel'=$1", [channel.id])).rowCount, "revoked work discarded");
  assert.equal(submitted, 0, "a sender revoked during startup cannot submit a model turn");
});

test("a cancelled managed item cannot submit after startup completes even if access remains allowed", async () => {
  const { db } = await testDatabase();
  const starting = Promise.withResolvers<void>();
  let created = false, submitted = 0;
  const provider: ChannelProvider = {
    managed: true, label: "Managed fixture", needsCredentials: false, maxMessageLength: 2000, maxFileBytes: 1024,
    setup: async () => ({ account: {}, masked: {} }), teardown: async () => {}, guard: async () => true,
    download: async () => { throw new Error("No files"); }, send: async () => {}, sendFile: async () => {},
  };
  const channels = new Channels({
    db, accounts: new Accounts({ db, tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), secretsKey: randomBytes(32).toString("hex") }),
    definitions: new Definitions({ db }), providers: { managed: provider }, node: "cancel-test", publicUrl: "https://camel.test",
    agentId: () => "client_cancel", live: async () => true,
    createAgent: async () => { created = true; await starting.promise; return { id: "client_cancel" }; },
    submit: async () => { submitted++; return { id: "req", method: "prompt", state: "running", fingerprint: "" }; },
  });
  const channel = await channels.create("alice", { type: "managed", access: { public: true } }, { managed: true });
  await channels.inbound(channel.id, { conversationId: "201", messageId: "message-1", sender: { id: "member" }, text: "start", files: [] });
  await until(() => created, "agent provisioning waits");
  await db.query("delete from channel_items where item->>'channel'=$1", [channel.id]);
  starting.resolve();
  await until(async () => (await db.query("select 1 from channel_conversations where channel=$1", [channel.id])).rowCount, "provisioning completes");
  // A rejected item leaves no submit; flush the asynchronous completion path.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(submitted, 0);
});
