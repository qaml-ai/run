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

test("exact lookup authenticates, validates and resolves the same tenant key without writes", async t => {
  const keys: string[] = [], paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    paths.push(new URL(url).pathname);
    assert.equal(options.method ?? "GET", "GET");
    assert.equal(new Headers(options.headers).get("xi-api-key"), "provider-fixture");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal);
    return Response.json(paths.at(-1) === "/v2/voices" ? { voices: [{ voice_id: "cat_voice" }] } : {
      ...shared, labels: expected.labels, sharing: { public_owner_id: "owner", status: "disabled" },
    });
  });
  const server = app(async tenant => { keys.push(tenant); return "provider-fixture"; });
  assert.equal((await server.request("/v1/voices/elevenlabs/cat_voice")).status, 401);
  for (const path of ["other/id", "elevenlabs/a%2Fb", "elevenlabs/a%5Cb", "elevenlabs/a%00b"]) {
    assert.equal((await server.request(`/v1/voices/${path}`, { headers: auth })).status, 400);
  }
  assert.deepEqual(keys, []);
  for (let i = 0; i < 2; i++) {
    const response = await server.request("/v1/voices/elevenlabs/cat_voice", { headers: auth });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ...expected, usable: true, reason: "Voice is available in the account" });
  }
  assert.deepEqual(keys, ["alice", "alice"]);
  assert.deepEqual(paths, ["/v2/voices", "/v1/voices/cat_voice", "/v2/voices", "/v1/voices/cat_voice"]);
});

test("exact lookup handles shared IDs unrelated to names, retirement and missing owners", async t => {
  const server = app(async () => "fixture");
  for (const [sharing, usable, reason] of [
    [{ public_owner_id: "owner", status: "enabled", enabled_in_library: true }, true, /can be added/],
    [{ public_owner_id: "owner", status: "disabled" }, false, /retired/],
    [{ public_owner_id: "owner", enabled_in_library: false }, false, /retired/],
    [{ public_owner_id: "owner", disable_at_unix: 1 }, false, /retired/],
    [null, false, /no public owner/],
  ] as const) {
    const mocked = t.mock.method(globalThis, "fetch", async (url: string) => {
      const path = new URL(url).pathname;
      assert.ok(["/v2/voices", "/v1/voices/cat_voice"].includes(path));
      return Response.json(path === "/v2/voices" ? { voices: [] } : { ...shared, labels: expected.labels, sharing });
    });
    const response = await server.request("/v1/voices/elevenlabs/cat_voice", { headers: auth });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.usable, usable);
    assert.match(result.reason, reason);
    assert.equal(result.name, "Cat");
    assert.equal(result.publicOwnerId, sharing?.public_owner_id ?? null);
    assert.equal(result.private_data, undefined);
    mocked.mock.restore();
  }
});

test("exact lookup reuses a paginated account copy and defaults absent metadata", async t => {
  const paths: URL[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const path = new URL(url); paths.push(path);
    if (path.pathname === "/v2/voices") return Response.json(path.searchParams.has("next_page_token") ? {
      voices: [{ voice_id: "account_copy", sharing: { original_voice_id: "cat_voice" } }], has_more: false,
    } : { voices: [], has_more: true, next_page_token: "page two" });
    assert.equal(path.pathname, "/v1/voices/account_copy");
    return Response.json({ voice_id: "account_copy" });
  });
  const response = await app(async () => "fixture").request("/v1/voices/elevenlabs/cat_voice", { headers: auth });
  assert.deepEqual(await response.json(), { provider: "elevenlabs", id: "cat_voice", name: "cat_voice", description: null, labels: {},
    publicOwnerId: null, previewUrl: null, category: null, usable: true, reason: "Voice is available in the account" });
  assert.equal(paths[1].searchParams.get("next_page_token"), "page two");
});

test("exact lookup returns 404 for unknown IDs and sanitizes upstream failures", async t => {
  const server = app(async () => "private-fixture");
  for (const [reply, status, code] of [
    [() => new Response("private-fixture", { status: 404 }), 404, "VOICE_NOT_FOUND"],
    ...[401, 403, 429, 500].map(status => [() => new Response("private-fixture", { status }), 502, "VOICE_LOOKUP_FAILED"]),
    [() => Response.json({ voice_id: "wrong-id" }), 502, "VOICE_LOOKUP_FAILED"],
    [() => Response.json({ voice_id: "cat_voice", labels: { bad: 1 } }), 502, "VOICE_LOOKUP_FAILED"],
    [() => { throw new Error("private-fixture"); }, 502, "VOICE_LOOKUP_FAILED"],
  ] as [() => Response, number, string][]) {
    const mocked = t.mock.method(globalThis, "fetch", async (url: string) => new URL(url).pathname === "/v2/voices" ? Response.json({ voices: [] }) : reply());
    const response = await server.request("/v1/voices/elevenlabs/cat_voice", { headers: auth });
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.code, code);
    assert.ok(!JSON.stringify(body).includes("private-fixture"));
    mocked.mock.restore();
  }
  for (const page of [{ voices: [] , has_more: true }, { voices: [], has_more: true, next_page_token: "loop" }, {}]) {
    const mocked = t.mock.method(globalThis, "fetch", async () => Response.json(page));
    assert.equal((await server.request("/v1/voices/elevenlabs/cat_voice", { headers: auth })).status, 502);
    mocked.mock.restore();
  }
  const response = await app(async () => undefined).request("/v1/voices/elevenlabs/id", { headers: auth });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "VOICE_LOOKUP_UNAVAILABLE");
});

test("exact fixed-list lookups are case sensitive, need no key and reject unknown IDs", async () => {
  const server = app(async () => { throw new Error("must not resolve keys"); });
  for (const [provider, id] of [["openai", "marin"], ["grok", "ara"], ["gemini", "Kore"]]) {
    const response = await server.request(`/v1/voices/${provider}/${id}`, { headers: auth });
    assert.equal(response.status, 200);
    const voice = await response.json();
    assert.equal(voice.id, id);
    assert.equal(voice.usable, true);
    for (const invalid of [id.toUpperCase(), "unknown", id.slice(0, 2)]) {
      assert.equal((await server.request(`/v1/voices/${provider}/${invalid}`, { headers: auth })).status, 404);
    }
  }
});

test("TypeScript runtime and Agents expose voices.get and encode IDs", async () => {
  const requests: URL[] = [];
  const request: typeof fetch = async (url, options) => {
    requests.push(new URL(String(url)));
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer tenant-token");
    return Response.json({ ...expected, usable: true, reason: "Available" });
  };
  for (const Client of [AgentRuntime, Agents]) {
    const client = new Client({ url: "https://runtime.example", apiKey: "tenant-token", fetch: request });
    assert.equal((await client.voices.get("elevenlabs", "cat & kitten?")).usable, true);
  }
  assert.ok(requests.every(url => url.pathname === "/v1/voices/elevenlabs/cat%20%26%20kitten%3F" && !url.search));
});

test("exact lookup uses the account key fallback, and does not misreport account-list failures as missing voices", async t => {
  const tenants: string[] = [];
  const server = api({
    accounts: {
      authenticate: async () => ({ tenant: "alice", via: "token" }),
      apiKey: async (tenant: string, provider: string) => { tenants.push(tenant); assert.equal(provider, "elevenlabs"); return "fixture"; },
    }, consoleAuth: { principal: async () => undefined },
  } as unknown as ApiContext);
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(new URL(url).pathname, "/v2/voices");
    return new Response("private fixture", { status: 403 });
  });
  const response = await server.request("/v1/voices/elevenlabs/id", { headers: auth });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "ElevenLabs voice lookup failed", code: "VOICE_LOOKUP_FAILED" });
  assert.deepEqual(tenants, ["alice"]);
});
