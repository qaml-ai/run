// Loaded only by the WIF runtime test's server process. Neither path can reach AWS or Anthropic.
import assert from "node:assert/strict";
import { GetWebIdentityTokenCommand, STSClient } from "@aws-sdk/client-sts";

const endpoint = process.env.TEST_ANTHROPIC_FEDERATION_ENDPOINT;
assert.ok(endpoint?.startsWith("http://127.0.0.1:"));
const realFetch = globalThis.fetch;
STSClient.prototype.send = async command => {
  assert.ok(command instanceof GetWebIdentityTokenCommand);
  const response = await realFetch(`${endpoint}/sts`, { method: "POST", body: JSON.stringify(command.input) });
  return response.json();
};
globalThis.fetch = (input, init) => realFetch(String(input) === "https://api.anthropic.com/v1/oauth/token" ? `${endpoint}/v1/oauth/token` : input, init);
