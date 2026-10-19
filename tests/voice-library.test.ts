import { test } from "node:test";
import assert from "node:assert/strict";
import { api, type ApiContext } from "../src/api.ts";
import { searchVoices, VoiceSearchInput } from "../src/voice-library.ts";
import { AgentRuntime } from "../clients/typescript.ts";
import { Agents } from "../clients/agents.ts";

const shared = {
  voice_id: "cat_voice", name: "Cat", description: "A playful character", accent: "american", age: "young", gender: "female",
  use_case: "characters_animation", preview_url: "https://example.com/cat.mp3", category: "professional",
  public_owner_id: "owner", private_data: "never returned",
};
const expected = { provider: "elevenlabs", id: "cat_voice", name: "Cat", description: "A playful character",
  labels: { accent: "american", age: "young", gender: "female", use_case: "characters_animation" }, publicOwnerId: "owner", previewUrl: "https://example.com/cat.mp3", category: "professional" };

function app(key?: ApiContext["voiceLibraryKey"]) {
  return api({
    accounts: { authenticate: async (authorization: string) => authorization === "Bearer tenant-token" ? { tenant: "alice", via: "token" } : undefined },
    consoleAuth: { principal: async () => undefined }, voiceLibraryKey: key,
  } as unknown as ApiContext);
}
const auth = { Authorization: "Bearer tenant-token" };

test("voice search authenticates, validates before key resolution and returns fresh bounded public metadata", async t => {
  const keys: string[] = [], queries: URL[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    queries.push(new URL(url));
    assert.equal(new Headers(options.headers).get("xi-api-key"), "provider-fixture");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal);
    return Response.json({ voices: [shared, shared], has_more: true });
  });
  const server = app(async tenant => { keys.push(tenant); return "provider-fixture"; });
  assert.equal((await server.request("/v1/voices/search?provider=elevenlabs")).status, 401);
  assert.equal((await server.request("/v1/voices/search?provider=elevenlabs", { headers: { Authorization: "Bearer bad" } })).status, 401);
  for (const query of ["", "provider=other", "provider=elevenlabs&limit=0", "provider=elevenlabs&limit=31", "provider=elevenlabs&limit=1.5", "provider=elevenlabs&limit=", "provider=elevenlabs&category=unknown"]) {
    assert.equal((await server.request(`/v1/voices/search?${query}`, { headers: auth })).status, 400, query);
  }
  assert.deepEqual(keys, []);
  for (let i = 0; i < 2; i++) {
    const response = await server.request("/v1/voices/search?provider=elevenlabs&q=cat%20%26%20kitten&category=professional&limit=1", { headers: auth });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { voices: [expected] });
  }
  assert.deepEqual(keys, ["alice", "alice"]);
  assert.equal(queries.length, 2);
  assert.equal(queries[0].origin, "https://api.elevenlabs.io");
  assert.equal(queries[0].pathname, "/v1/shared-voices");
  assert.deepEqual(Object.fromEntries(queries[0].searchParams), { search: "cat & kitten", page_size: "1", category: "professional" });
});

test("voice search defaults, missing optional metadata and empty results", async () => {
  const input = VoiceSearchInput.parse({ provider: "elevenlabs" });
  assert.equal(input.limit, "10");
  assert.equal(input.q, "");
  let calls = 0;
  const request = async (url: any) => {
    assert.equal(new URL(url).searchParams.get("page_size"), "10");
    return Response.json({ voices: calls++ ? [] : [{ voice_id: "minimal", name: "Minimal" }] });
  };
  assert.deepEqual(await searchVoices(input, async () => "fixture", request), { voices: [{ provider: "elevenlabs", id: "minimal", name: "Minimal", description: null, labels: {}, publicOwnerId: null, previewUrl: null, category: null }] });
  assert.deepEqual(await searchVoices(input, async () => "fixture", request), { voices: [] });
});

test("voice search sanitizes upstream failures, malformed responses and transport errors", async t => {
  const server = app(async () => "private-fixture");
  for (const request of [
    async () => new Response("private-fixture", { status: 401 }),
    async () => new Response("private-fixture", { status: 429 }),
    async () => new Response("private-fixture", { status: 500 }),
    async () => Response.json({ voices: [{ voice_id: null }] }),
    async () => { throw new Error("private-fixture"); },
  ]) {
    const mocked = t.mock.method(globalThis, "fetch", request);
    const response = await server.request("/v1/voices/search?provider=elevenlabs", { headers: auth });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "ElevenLabs voice search failed", code: "VOICE_SEARCH_FAILED" });
    mocked.mock.restore();
  }
  const missing = await app(async () => undefined).request("/v1/voices/search?provider=elevenlabs", { headers: auth });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "VOICE_SEARCH_UNAVAILABLE");
});

test("fixed voices use provider definitions and filter case insensitively without credentials", async () => {
  const key = async (): Promise<string> => { throw new Error("should not resolve a key"); };
  for (const [provider, q, id] of [["grok", "ARA", "ara"], ["openai", "MAR", "marin"], ["gemini", "kOr", "Kore"]]) {
    const result = await searchVoices(VoiceSearchInput.parse({ provider, q }), key);
    assert.deepEqual(result.voices.map(voice => voice.id), [id]);
  }
  assert.equal((await searchVoices(VoiceSearchInput.parse({ provider: "openai", limit: "1" }), key)).voices.length, 1);
  assert.deepEqual(await searchVoices(VoiceSearchInput.parse({ provider: "openai", category: "professional" }), key), { voices: [] });
});

test("TypeScript runtime and Agents expose voices.search and encode query parameters", async () => {
  const requests: { url: URL; token: string | null }[] = [];
  const request: typeof fetch = async (url, options) => {
    requests.push({ url: new URL(String(url)), token: new Headers(options?.headers).get("authorization") });
    return Response.json({ voices: [expected] });
  };
  const runtime = new AgentRuntime({ url: "https://runtime.example", apiKey: "tenant-token", fetch: request });
  assert.deepEqual(await runtime.voices.search({ provider: "elevenlabs", q: "cat & kitten", limit: 3, category: "professional" }), { voices: [expected] });
  const agents = new Agents({ url: "https://runtime.example", apiKey: "tenant-token", fetch: request });
  await agents.voices.search({ provider: "openai", q: "mar" });
  assert.equal(requests[0].url.pathname, "/v1/voices/search");
  assert.equal(requests[0].url.searchParams.get("q"), "cat & kitten");
  assert.equal(requests[0].url.searchParams.get("limit"), "3");
  assert.equal(requests[1].url.searchParams.get("provider"), "openai");
  assert.ok(requests.every(request => request.token === "Bearer tenant-token"));
});
