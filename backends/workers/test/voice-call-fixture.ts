import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { startFixture } from "./fixture.ts";

export async function callFixture(t: TestContext, base: string, vars: Record<string, string> = {}, modelURL?: string) {
  const fixture = await startFixture({
    modelURL,
    entrypoint: fileURLToPath(new URL("./voice-call-worker.ts", import.meta.url)),
    vars: { MEDIA_BASE_URL: base, PLATFORM_OPENAI_KEY: "synthetic-openai", AGENT_VOICE_SESSIONS_PER_TENANT: "1", ...vars },
  });
  t.after(() => fixture.stop());
  async function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}, auth = true) {
    const response = await fetch(fixture.url + path, { method, headers: {
      ...(auth ? { Authorization: `Bearer ${fixture.token}` } : {}), ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
  }
  const agent = await request("/v1/agents", "POST", { codeMode: false });
  assert.equal(agent.status, 201, JSON.stringify(agent.json));
  const input = { agent: agent.json.id as string, subject: "client-person" };
  return { ...fixture, request, input, create: (options: object, headers?: Record<string, string>) =>
    request("/v1/voice/sessions", "POST", { ...input, ...options }, headers) };
}

export async function eventually<T>(read: () => Promise<T | false | undefined>): Promise<T> {
  const until = Date.now() + 12_000;
  while (Date.now() < until) {
    const value = await read();
    if (value !== false && value !== undefined) return value;
    await sleep(50);
  }
  throw new Error("Timed out waiting for voice call");
}
