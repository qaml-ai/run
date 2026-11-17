import assert from "node:assert/strict";
import test from "node:test";
import { idleCompactionPayload, readIdleCompactionCache } from "../src/model-idle-compaction-payload.ts";

const prompt = "Summarize the earlier part of this conversation.";
const breakpoint = { type: "ephemeral", ttl: "5m" };

function responsePayload(historyBreakpoint: { type: string; ttl?: string } | null = breakpoint) {
  return {
    model: "claude-sonnet-4-5",
    system: [{ type: "text", text: "System instructions", cache_control: breakpoint }],
    tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" }, cache_control: breakpoint }],
    messages: [
      { role: "user", content: [{ type: "text", text: "First input" }] },
      { role: "assistant", content: [{ type: "text", text: "First answer" }] },
      { role: "user", content: [{ type: "text", text: "Latest input", ...(historyBreakpoint ? { cache_control: historyBreakpoint } : {}) }] },
    ],
    max_tokens: 1024,
    stream: true,
  };
}

function mergedSummaryPayload(payload: ReturnType<typeof responsePayload>) {
  return {
    ...payload,
    messages: [...payload.messages.slice(0, -1), {
      role: "user",
      content: [{ type: "text", text: "Latest input" }, { type: "text", text: prompt, cache_control: breakpoint }],
    }],
    max_tokens: 512,
  };
}

test("the latest response must have an explicit conversation cache breakpoint", async () => {
  assert.equal((await readIdleCompactionCache(responsePayload()))?.ttlMs, 300_000);
  assert.equal((await readIdleCompactionCache(responsePayload({ type: "ephemeral", ttl: "1h" })))?.ttlMs, 3_600_000);
  assert.equal((await readIdleCompactionCache(responsePayload({ type: "ephemeral" })))?.ttlMs, 300_000);
  assert.equal(await readIdleCompactionCache(responsePayload({ type: "ephemeral", ttl: "24h" })), undefined);
  assert.equal(await readIdleCompactionCache(responsePayload(null)), undefined, "system and tool breakpoints alone do not cover the conversation");
});

test("the summary request leaves the conversation cache breakpoint before its extra instruction", async () => {
  const payload = responsePayload();
  const cache = await readIdleCompactionCache(payload);
  assert.ok(cache);
  const input = mergedSummaryPayload(payload);
  const before = structuredClone(input);
  const rewritten = await idleCompactionPayload(input, cache, prompt);
  assert.deepEqual(rewritten, {
    ...input,
    messages: [...input.messages.slice(0, -1), {
      role: "user",
      content: [...payload.messages.at(-1)!.content, { type: "text", text: prompt }],
    }],
  });
  assert.deepEqual(input, before);
});

test("a separate summary message keeps the old cache prefix and adds no breakpoint", async () => {
  const payload = responsePayload({ type: "ephemeral", ttl: "1h" });
  payload.messages.push({ role: "assistant", content: [{ type: "text", text: "Latest answer" }] });
  const cache = await readIdleCompactionCache(payload);
  assert.ok(cache);
  assert.doesNotMatch(JSON.stringify(cache), /Latest input|Latest answer|System instructions/);
  const input = {
    ...payload,
    messages: [...responsePayload(null).messages, payload.messages.at(-1)!, {
      role: "user",
      content: [{ type: "text", text: prompt, cache_control: breakpoint }],
    }],
  };
  assert.deepEqual(await idleCompactionPayload(input, cache, prompt), {
    ...input,
    messages: [...payload.messages, { role: "user", content: [{ type: "text", text: prompt }] }],
  });
});

test("Claude's trailing thinking effort marker stays in place and must match the original request", async () => {
  const payload = responsePayload();
  const effort = { role: "system", content: [], output_config: { effort: "high" } };
  const cachedPayload = { ...payload, messages: [...payload.messages, effort] };
  const cache = readIdleCompactionCache(cachedPayload);
  assert.ok(cache);

  const input = mergedSummaryPayload(payload);
  const rewritten = idleCompactionPayload({ ...input, messages: [...input.messages, effort] }, cache, prompt);
  assert.deepEqual(rewritten, {
    ...input,
    messages: [...payload.messages.slice(0, -1), {
      role: "user",
      content: [...payload.messages.at(-1)!.content, { type: "text", text: prompt }],
    }, effort],
  });
  const changedEffort = { ...effort, output_config: { effort: "low" } };
  assert.equal(idleCompactionPayload({ ...input, messages: [...input.messages, changedEffort] }, cache, prompt), undefined);
});

test("a deferred system update retains its cache breakpoint and precedes the summary instruction", () => {
  const base = responsePayload(null);
  const system = { role: "system", content: [{ type: "text", text: 'Removed system prompt section "structured_output".', cache_control: breakpoint }] };
  const effort = { role: "system", content: [], output_config: { effort: "high" } };
  for (const tail of [[], [effort]]) {
    const original = { ...base, messages: [...base.messages, system, ...tail] };
    const cache = readIdleCompactionCache(original);
    assert.ok(cache);
    const replay = { ...base, messages: [...base.messages, { role: "user", content: prompt }, system, ...tail] };
    assert.deepEqual(idleCompactionPayload(replay, cache, prompt), {
      ...base, messages: [...base.messages, system, { role: "user", content: [{ type: "text", text: prompt }] }, ...tail],
    });
    const changed = { ...system, content: [{ ...system.content[0], text: "Changed system update" }] };
    assert.equal(idleCompactionPayload({ ...base, messages: [...base.messages, { role: "user", content: prompt }, changed, ...tail] }, cache, prompt), undefined);
  }
});

test("idle compaction declines when the provider prefix no longer matches", async () => {
  const payload = responsePayload();
  const cache = await readIdleCompactionCache(payload);
  assert.ok(cache);
  const input = mergedSummaryPayload(payload);
  for (const candidate of [
    { ...input, model: "claude-opus-4-6" },
    { ...input, system: [{ type: "text", text: "Changed system instructions", cache_control: breakpoint }] },
    { ...input, tools: [{ ...payload.tools[0], description: "Changed tool description" }] },
    { ...input, messages: [{ role: "user", content: [{ type: "text", text: "Changed first input" }] }, ...input.messages.slice(1)] },
  ]) {
    assert.equal(await idleCompactionPayload(candidate, cache, prompt), undefined);
  }
  assert.equal(await idleCompactionPayload(payload, cache, prompt), undefined, "a missing summary instruction is rejected");
});
