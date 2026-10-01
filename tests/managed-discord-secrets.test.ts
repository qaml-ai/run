import { test } from "node:test";
import assert from "node:assert/strict";
import { managedDiscordSecrets } from "../src/secrets.ts";

const configured = {
  AGENT_DISCORD_MANAGED_ENABLED: "true",
  AGENT_DISCORD_MANAGED_BOT_TOKEN: "fixture-token-".padEnd(60, "x"),
  AGENT_DISCORD_MANAGED_APPLICATION_ID: "999000000000000001",
  AGENT_DISCORD_MANAGED_CLIENT_SECRET: "fixture-client-secret",
  AGENT_DISCORD_MANAGED_PUBLIC_KEY: "ab".repeat(32),
};

test("managed Discord credentials alone do not enable the integration", async () => {
  for (const enabled of [undefined, "false", "1", "TRUE"]) {
    assert.equal(await managedDiscordSecrets({ ...configured, AGENT_DISCORD_MANAGED_ENABLED: enabled }), undefined);
  }
  assert.deepEqual(await managedDiscordSecrets(configured), {
    botToken: configured.AGENT_DISCORD_MANAGED_BOT_TOKEN,
    applicationId: configured.AGENT_DISCORD_MANAGED_APPLICATION_ID,
    clientSecret: configured.AGENT_DISCORD_MANAGED_CLIENT_SECRET,
    publicKey: configured.AGENT_DISCORD_MANAGED_PUBLIC_KEY,
  });
});

test("managed Discord rejects invalid application credentials without exposing them", async () => {
  for (const [name, value] of [
    ["AGENT_DISCORD_MANAGED_BOT_TOKEN", "invalid-bot-token-secret"],
    ["AGENT_DISCORD_MANAGED_APPLICATION_ID", "a-server-name"],
    ["AGENT_DISCORD_MANAGED_PUBLIC_KEY", "malformed-signing-key"],
  ]) {
    await assert.rejects(managedDiscordSecrets({ ...configured, [name]: value }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /valid.*botToken, applicationId, clientSecret, publicKey/);
      assert.equal(error.message.includes(value), false);
      return true;
    });
  }
});

test("managed Discord rejects mixing plain credentials and a secret ARN before contacting AWS", async () => {
  await assert.rejects(managedDiscordSecrets({
    ...configured, AGENT_DISCORD_MANAGED_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:000000000000:secret:fixture",
  }), /not both/);
});
