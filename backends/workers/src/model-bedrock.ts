import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

// Pi's Bedrock transport defaults to the AWS SDK's three attempts. As in
// src/compaction.ts, retries belong to the runtime, including none for gateways.
const noRetries = {
  acquireInitialRetryToken: async () => ({ getRetryCount: () => 0, getRetryDelay: () => 0 }),
  refreshRetryTokenForRetry: async () => { throw new Error("No retries"); },
  recordSuccess: () => {},
};
const send = BedrockRuntimeClient.prototype.send;
BedrockRuntimeClient.prototype.send = function (this: BedrockRuntimeClient, ...args: unknown[]) {
  (this.config as { retryStrategy: unknown }).retryStrategy = async () => noRetries;
  return (send as (...args: unknown[]) => unknown).apply(this, args);
} as typeof send;
