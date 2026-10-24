import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { capRequestImages, requestImageLimit } from "../src/request-images.ts";
import { estimateTokens } from "../src/pi-harness/tokens.ts";

const model = (provider: string, id: string, api: Api = "openai-completions") => ({ provider, id, api });
const image = (index: number) => ({ type: "image" as const, mimeType: "image/png", data: String(index) });
const images = (messages: Message[]) => messages.flatMap(message => Array.isArray(message.content)
  ? message.content.filter(block => block.type === "image") : []);

test("image caps follow the upstream provider, including gateways and unknown models", () => {
  for (const [target, limit] of [
    [model("openai", "gpt-6-luna", "openai-responses"), 40],
    [model("openrouter", "openai/gpt-6-luna"), 40],
    [model("azure", "gpt-6-luna", "azure-openai-responses"), 40],
    [model("google", "gemini"), 40],
    [model("custom", "unknown"), 40],
    [model("anthropic", "claude"), 90],
    [model("openrouter", "anthropic/claude"), 90],
    [model("tenant", "openrouter/anthropic/claude"), 90],
    [model("amazon-bedrock", "us.anthropic.claude", "bedrock-converse-stream"), 90],
    [model("tenant", "claude", "anthropic-messages"), 90],
  ] as [Pick<Model<Api>, "provider" | "id" | "api">, number][]) assert.equal(requestImageLimit(target), limit);
});

test("zero images and exactly the cap preserve messages", () => {
  for (const target of [model("openai", "gpt"), model("openrouter", "anthropic/claude")]) {
    for (const count of [0, requestImageLimit(target)]) {
      const messages: Message[] = [{ role: "user", timestamp: 1, content: [{ type: "text", text: "hello" }, ...Array.from({ length: count }, (_, i) => image(i))] }];
      const result = capRequestImages(messages, target);
      assert.deepEqual(result, messages);
      assert.equal(result[0], messages[0]);
    }
  }
});

test("keep the newest images across user messages and tool results without editing the transcript", () => {
  for (const target of [model("openai", "gpt"), model("openrouter", "anthropic/claude")]) {
    const limit = requestImageLimit(target);
    const messages: Message[] = [
      { role: "user", timestamp: 1, content: [image(0)] },
      { role: "toolResult", toolCallId: "call", toolName: "screenshot", isError: false, timestamp: 2, content: [image(1), image(2)] },
      { role: "user", timestamp: 3, content: [{ type: "text", text: "recent" }, ...Array.from({ length: limit }, (_, i) => image(i + 3))] },
    ];
    const before = structuredClone(messages);
    const result = capRequestImages(messages, target);
    assert.equal(images(result).length, limit);
    assert.deepEqual(images(result).map(block => block.type === "image" && block.data), Array.from({ length: limit }, (_, i) => String(i + 3)));
    assert.deepEqual(result[0].content, [{ type: "text", text: `[image omitted: older than the last ${limit} images]` }]);
    assert.deepEqual(result[1], { ...messages[1], content: Array(2).fill({ type: "text", text: `[image omitted: older than the last ${limit} images]` }) });
    assert.deepEqual(messages, before);
    assert.ok(estimateTokens(messages[1]) > estimateTokens(result[1]), "omitted images no longer incur the image token estimate");
  }
});

test("PDF transport blocks do not consume the image budget", () => {
  const messages: Message[] = [{ role: "user", timestamp: 1, content: [
    ...Array.from({ length: 40 }, (_, i) => image(i)), { type: "image", mimeType: "application/pdf", data: "pdf" },
  ] }];
  assert.deepEqual(capRequestImages(messages, model("openai", "gpt")), messages);
});
