import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import worker, { fetchLegacyApi } from "../ingress/index.ts";

test("dispatches native and legacy requests once, preserving the origin response", async t => {
  const legacyRedirect = new Response(null, { status: 307, headers: { Location: "/login" } });
  const origin = t.mock.method(globalThis, "fetch", async () => legacyRedirect);
  const nativeFailure = new Response(null, { status: 503 });
  const native = t.mock.fn(async (_request: Request) => nativeFailure);
  const env = { V2: { fetch: native } };

  for (const path of ["/v2", "/v2/agents/example/runs"]) {
    const request = new Request("https://run.camelai.com" + path, { method: "POST", body: "{\"text\":\"test\"}" });
    assert.equal(await worker.fetch(request, env), nativeFailure);
    assert.equal(native.mock.calls.at(-1)?.arguments[0], request);
  }
  assert.equal(native.mock.callCount(), 2);
  assert.equal(origin.mock.callCount(), 0);

  for (const path of ["/v1/agents", "/mcp", "/v20", "/oauth/authorize"]) {
    const request = new Request("https://run.camelai.com" + path);
    assert.equal(await worker.fetch(request, env), legacyRedirect);
    assert.deepEqual(origin.mock.calls.at(-1)?.arguments, [request, { redirect: "manual" }]);
  }
  assert.equal(native.mock.callCount(), 2);
  assert.equal(origin.mock.callCount(), 4);
});

test("preserves routes and the request host on the legacy alias", async t => {
  const response = new Response(null, { status: 204 });
  const origin = t.mock.method(globalThis, "fetch", async () => response);
  const native = t.mock.fn(async (_request: Request) => new Response(null));
  const env = { V2: { fetch: native } };
  for (const path of ["/v2/health", "/mcp", "/.well-known/oauth-protected-resource", "/v1/billing/stripe/webhook"]) {
    const request = new Request("https://agents.camelai.dev" + path);
    assert.equal(await worker.fetch(request, env), response);
    assert.deepEqual(origin.mock.calls.at(-1)?.arguments, [request, { redirect: "manual" }]);
  }
  assert.equal(native.mock.callCount(), 0);
});

test("uses ECS only for legacy compatibility misses and keeps the original request body", async t => {
  const path = `/v1/agents/client_${"0".repeat(40)}/prompt`;
  const answer = new Response(null, { status: 503 });
  const origin = t.mock.method(globalThis, "fetch", async (request: Request) => Response.json(await request.json()));
  const route = t.mock.fn(async (request: Request) => {
    const body = await request.json() as { migrated: boolean };
    return body.migrated ? answer : null;
  });
  const env = { V2: { fetch: async () => new Response(null) }, LEGACY_V1: { route } };
  const prompt = (migrated: boolean) => new Request("https://run.camelai.com" + path, {
    method: "POST", body: JSON.stringify({ migrated }),
  });
  assert.equal(await worker.fetch(prompt(true), env), answer);
  assert.equal(origin.mock.callCount(), 0);
  assert.deepEqual(await (await worker.fetch(prompt(false), env)).json(), { migrated: false });
  assert.equal(origin.mock.callCount(), 1);
  assert.equal(route.mock.callCount(), 2);
});

test("serves the original bearer identity on both hosts and leaves console traffic and unexpected errors alone", async t => {
  const authorization = "Bearer original-key";
  const origin = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }));
  const unavailable = new Error("database unavailable");
  const route = t.mock.fn(async (request: Request) => {
    if (request.headers.get("authorization") !== authorization) return null;
    if (new URL(request.url).search) throw unavailable;
    return Response.json({ tenant: "legacy" });
  });
  const env = { V2: { fetch: async () => new Response(null) }, LEGACY_V1: { route } };
  for (const host of ["run.camelai.com", "agents.camelai.dev"]) {
    const url = `https://${host}/v1/me`;
    const bearer = { headers: { authorization } };
    assert.deepEqual(await (await worker.fetch(new Request(url, bearer), env)).json(), { tenant: "legacy" });
    assert.equal(route.mock.calls.at(-1)?.arguments[0].url, url);
    assert.equal((await worker.fetch(new Request(url, { headers: { cookie: "console=session" } }), env)).status, 401);
    assert.equal((await worker.fetch(new Request(url, { headers: { authorization: "Bearer refused" } }), env)).status, 401);
    assert.equal((await worker.fetch(new Request(url, { method: "HEAD", ...bearer }), env)).status, 401);
    await assert.rejects(worker.fetch(new Request(url + "?unavailable", bearer), env), error => error === unavailable);
  }
  assert.equal((await worker.fetch(new Request("https://example.com/v1/me", { headers: { authorization } }), env)).status, 401);
  assert.equal(route.mock.callCount(), 6);
  assert.equal(origin.mock.callCount(), 7);
});

test("offers hosted MCP on both hosts and limits its origin binding to the legacy API", async t => {
  const answer = new Response(null, { status: 202 });
  const origin = t.mock.method(globalThis, "fetch", async () => answer);
  const route = t.mock.fn(async () => answer);
  const env = { V2: { fetch: async () => new Response(null) }, LEGACY_V1: { route } };
  for (const host of ["run.camelai.com", "agents.camelai.dev"]) {
    assert.equal(await worker.fetch(new Request(`https://${host}/mcp`), env), answer);
    assert.equal(await fetchLegacyApi(new Request(`https://${host}/v1/agents`)), answer);
  }
  for (const url of ["https://example.com/v1/agents", "https://run.camelai.com/mcp", "https://run.camelai.com/v2/health"]) {
    assert.equal((await fetchLegacyApi(new Request(url))).status, 404);
  }
  assert.equal(route.mock.callCount(), 2);
  assert.equal(origin.mock.callCount(), 2);
});

test("can select one test credential before sending all legacy requests to the Worker", async t => {
  const origin = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 202 }));
  const route = t.mock.fn(async () => new Response(null, { status: 204 }));
  const authorization = "Bearer synthetic-cutover-credential";
  const env = { V2: { fetch: async () => new Response(null) }, LEGACY_V1: { route },
    LEGACY_V1_CANARY_AUTH_SHA256: createHash("sha256").update(authorization).digest("hex") };
  const path = "https://run.camelai.com/mcp";
  assert.equal((await worker.fetch(new Request(path), env)).status, 202);
  assert.equal((await worker.fetch(new Request(path, { headers: { authorization: "Bearer different" } }), env)).status, 202);
  assert.equal((await worker.fetch(new Request(path, { headers: { authorization } }), env)).status, 204);
  assert.equal(route.mock.callCount(), 1);
  assert.equal(origin.mock.callCount(), 2);
});

test("offers bearer credential reads by provisioning key on both legacy hosts", async t => {
  const fallback = new Response(null, { status: 418 });
  const refused = new Response(null, { status: 403 });
  const origin = t.mock.method(globalThis, "fetch", async () => fallback);
  const route = t.mock.fn(async (_request: Request) => refused);
  const env = { V2: { fetch: async () => new Response(null) }, LEGACY_V1: { route } };
  const options = { headers: { authorization: "Bearer fixture" } };
  const path = (ref: string) => `/v1/agents/${ref}/credentials`;
  for (const host of ["run.camelai.com", "agents.camelai.dev"]) {
    for (const ref of ["original-key", "%6Friginal-key"]) {
      const request = new Request(`https://${host}${path(ref)}`, options);
      assert.equal(await worker.fetch(request, env), refused);
      assert.equal(route.mock.calls.at(-1)?.arguments[0].url, request.url);
    }
  }
  for (const request of [
    new Request(`https://example.com${path("original-key")}`, options),
    new Request(`https://run.camelai.com${path("original-key")}`),
    new Request(`https://run.camelai.com${path("original-key")}`, { ...options, method: "POST" }),
    new Request(`https://run.camelai.com${path("original-key")}`, { headers: { ...options.headers, upgrade: "websocket" } }),
    new Request(`https://run.camelai.com${path("a".repeat(81))}`, options),
    new Request(`https://run.camelai.com${path("%xx")}`, options),
  ]) {
    assert.equal(await worker.fetch(request, env), fallback);
    assert.deepEqual(origin.mock.calls.at(-1)?.arguments, [request, { redirect: "manual" }]);
  }
  assert.equal(route.mock.callCount(), 4);
});

test("keeps legacy end-user writes on the origin while serving reads on the Worker", async t => {
  const origin = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 201 }));
  const route = t.mock.fn(async () => new Response(null, { status: 204 }));
  const env = { V2: { fetch: async () => new Response(null) }, LEGACY_V1: { route } };
  for (const path of ["/v1/end-users", "/v1/end-users/example", "/v1/end-users/example/usage", "/v1/end-users/example/days", "/v1/end-users/example/ledger"]) {
    const url = `https://run.camelai.com${path}`;
    assert.equal((await worker.fetch(new Request(url), env)).status, 204);
    assert.equal((await worker.fetch(new Request(url, { method: "POST" }), env)).status, 201);
  }
  assert.equal((await worker.fetch(new Request("https://agents.camelai.dev/v1/end-users/example/entries", { method: "POST" }), env)).status, 201);
  assert.equal(route.mock.callCount(), 5);
  assert.equal(origin.mock.callCount(), 6);
});

test("serves registration, token exchange, revocation and discovery on the existing hostnames", async t => {
  const origin = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 202 }));
  const route = t.mock.fn(async () => new Response(null, { status: 204 }));
  const env = { V2: { fetch: async () => new Response(null) }, LEGACY_V1: { route } };
  for (const host of ["run.camelai.com", "agents.camelai.dev"]) {
    for (const pathname of ["/oauth/register", "/oauth/token", "/oauth/revoke"]) {
      for (const method of ["POST", "OPTIONS"]) {
        assert.equal((await worker.fetch(new Request(`https://${host}${pathname}`, { method }), env)).status, 204);
      }
    }
    for (const pathname of ["/.well-known/oauth-authorization-server", "/.well-known/jwks.json", "/.well-known/oauth-protected-resource/v1/ops/mcp"]) {
      assert.equal((await worker.fetch(new Request(`https://${host}${pathname}`), env)).status, 204);
    }
    assert.equal((await worker.fetch(new Request(`https://${host}/oauth/authorize`), env)).status, 202);
  }
  assert.equal(route.mock.callCount(), 18);
  assert.equal(origin.mock.callCount(), 2);
});

test("selects legacy decisions independently and sends each selected POST once", async t => {
  const origin = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 202 }));
  const authorization = "Bearer fixture-decision-key";
  const route = t.mock.fn(async (request: Request) => {
    assert.equal(request.headers.get("authorization"), authorization);
    assert.deepEqual(await request.json(), { state: "same body" });
    return null;
  });
  const v1 = t.mock.fn(async () => { throw new Error("Unrelated compatibility binding"); });
  const env = { V2: { fetch: async () => new Response(null) }, LEGACY_V1: { route: v1 }, LEGACY_DECISIONS: { route },
    LEGACY_DECISIONS_CANARY_AUTH_SHA256: createHash("sha256").update(authorization).digest("hex") };
  const post = (host: string, auth: string) => new Request(`https://${host}/v1/decisions`, {
    method: "POST", body: '{"state":"same body"}', headers: { authorization: auth },
  });
  for (const host of ["run.camelai.com", "agents.camelai.dev"]) {
    const response = await worker.fetch(post(host, authorization), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Decisions are unavailable", code: "DECISIONS_UNAVAILABLE" });
  }
  assert.equal(route.mock.callCount(), 2);
  assert.equal(origin.mock.callCount(), 0);
  assert.equal((await worker.fetch(post("run.camelai.com", "Bearer other"), env)).status, 202);
  assert.equal((await worker.fetch(post("example.com", authorization), env)).status, 202);
  assert.equal(route.mock.callCount(), 2);
  assert.equal(origin.mock.callCount(), 2);
  assert.equal(v1.mock.callCount(), 0);
});

test("routes only the original Camel Bots credential, including calls with no bot context", async t => {
  const authorization = "Bearer fixture-shared-camel-bots";
  const synthetic = "Bearer fixture-unbilled";
  const origin = t.mock.method(globalThis, "fetch", async (request: Request) => new Response(await request.text(), { status: 202 }));
  const route = t.mock.fn(async (request: Request) => new Response(await request.text()));
  const syntheticRoute = t.mock.fn(async (request: Request) => new Response(await request.text(), { status: 201 }));
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const env = { V2: { fetch: async () => new Response(null) }, LEGACY_BOT_DECISIONS: { route },
    LEGACY_DECISIONS_BOTS_AUTH_SHA256: digest(authorization), LEGACY_DECISIONS: { route: syntheticRoute },
    LEGACY_DECISIONS_CANARY_AUTH_SHA256: digest(synthetic) };
  const post = (body: string, auth = authorization, host = "run.camelai.com") => new Request(`https://${host}/v1/decisions`, {
    method: "POST", body, headers: { authorization: auth },
  });
  const bodies = [
    '{"state":"original body","context":{"bot":"b0011223344556677"},"subject":"owner","bucket":"decide:b0011223344556677"}',
    '{"items":[{"state":"batch without bot"}],"actor":"ops:prompt-categories"}',
    "{",
    " ".repeat(2*1024*1024+1),
  ];
  for (const host of ["run.camelai.com", "agents.camelai.dev"]) {
    for (const body of bodies) {
      const result = await worker.fetch(post(body, authorization, host), env);
      assert.equal(result.status, 200);
      assert.equal(await result.text(), body);
    }
    const existing = await worker.fetch(post(bodies[0]!, synthetic, host), env);
    assert.equal(existing.status, 201);
    assert.equal(await existing.text(), bodies[0]);
    const unselected = await worker.fetch(post(bodies[0]!, "Bearer wrong", host), env);
    assert.equal(unselected.status, 202);
    assert.equal(await unselected.text(), bodies[0]);
  }
  assert.equal((await worker.fetch(post(bodies[0]!), { ...env, LEGACY_DECISIONS_BOTS_AUTH_SHA256: "bad" })).status, 202);
  assert.equal((await worker.fetch(post(bodies[0]!), { ...env, LEGACY_BOT_DECISIONS: undefined })).status, 202);
  assert.equal((await worker.fetch(post(bodies[0]!, authorization, "example.invalid"), env)).status, 202);
  assert.equal(route.mock.callCount(), 8);
  assert.equal(syntheticRoute.mock.callCount(), 2);
  assert.equal(origin.mock.callCount(), 5);
});

test("routes volume and signed file traffic to the configured origin through both entrypoints", async t => {
  const origin = t.mock.method(globalThis, "fetch", async () => new Response("ECS"));
  const boundFetch = t.mock.fn(async (request: Request, init?: RequestInit) => {
    assert.equal(init?.redirect, "manual");
    assert.equal(request.headers.get("authorization"), "Bearer original-key");
    assert.equal(request.headers.get("x-camelrun-volume-origin"), "private origin token");
    assert.equal(request.headers.get("x-agent-runtime-internal"), null);
    if (request.method === "PUT") assert.equal(await request.text(), "updated");
    return new Response(request.url, { status: 202, headers: { "X-File-Version": "7" } });
  });
  const env = {
    V2: { fetch: async () => new Response(null) },
    LEGACY_VOLUMES: { fetch: boundFetch },
    LEGACY_VOLUMES_ORIGIN_TOKEN: "private origin token",
    LEGACY_VOLUMES_ROLLOUT: "all",
  };
  const original = { authorization: "Bearer original-key", "x-camelrun-volume-origin": "caller supplied", "x-agent-runtime-internal": "forged" };
  for (const path of ["/v1/volumes", "/v1/links/token/report%20A.pdf", "/v1/volumes/vol_example/files/report%20A.md?snapshot=snap_abc"]) {
    for (const send of [worker.fetch, fetchLegacyApi]) {
      const response = await send(new Request(`https://run.camelai.com${path}`, { headers: original }), env);
      assert.equal(response.status, 202);
      assert.equal(response.headers.get("x-file-version"), "7");
      assert.equal(await response.text(), `http://run.camelai.com${path}`);
    }
  }
  const file = "https://agents.camelai.dev/v1/volumes/vol_example/files/report.md";
  assert.equal((await worker.fetch(new Request(file, { method: "PUT", body: "updated", headers: original }), env)).status, 202);
  assert.equal(await (await worker.fetch(new Request("https://run.camelai.com/v1/volumes2"), env)).text(), "ECS");
  assert.equal(await (await worker.fetch(new Request("https://run.camelai.com/v1/volumes"), { V2: env.V2 })).text(), "ECS");
  assert.equal((await worker.fetch(new Request(file), { ...env, LEGACY_VOLUMES_ORIGIN_TOKEN: undefined })).status, 503);
  assert.equal(boundFetch.mock.callCount(), 7);
  assert.equal(origin.mock.callCount(), 2);
});

test("an enabled volume origin fails without retrying ECS", async t => {
  const origin = t.mock.method(globalThis, "fetch", async () => new Response("ECS"));
  const send = t.mock.fn(async () => { throw new Error("unreachable"); });
  const env = {
    V2: { fetch: async () => new Response(null) },
    LEGACY_VOLUMES: { fetch: send },
    LEGACY_VOLUMES_ORIGIN_TOKEN: "private origin token",
    LEGACY_VOLUMES_ROLLOUT: "all",
  };
  const response = await worker.fetch(new Request("https://run.camelai.com/v1/volumes"), env);
  assert.equal(response.status, 502);
  assert.equal((await response.json() as { code: string }).code, "VOLUME_ORIGIN_UNAVAILABLE");
  assert.equal(send.mock.callCount(), 1);
  assert.equal(origin.mock.callCount(), 0);
});

test("routes only selected volumes and their signed links during rollout", async t => {
  const ecs = t.mock.method(globalThis, "fetch", async () => new Response("ECS"));
  const sidecar = t.mock.fn(async () => new Response("volume origin"));
  const selected = "vol_111111111111111111111111";
  const other = "vol_222222222222222222222222";
  const env = {
    V2: { fetch: async () => new Response(null) },
    LEGACY_VOLUMES: { fetch: sidecar },
    LEGACY_VOLUMES_ORIGIN_TOKEN: "private origin token",
    LEGACY_VOLUMES_ROLLOUT: selected,
  };
  function signedPath(volume: string) {
    const payload = Buffer.from(JSON.stringify({ volume, path: "/fichier-écrit" })).toString("base64url");
    return `/v1/links/${payload}.signature/fichier-%C3%A9crit`;
  }
  for (const send of [worker.fetch, fetchLegacyApi]) {
    const request = (path: string) => new Request(`https://run.camelai.com${path}`);
    for (const path of [`/v1/volumes/${selected}/files/draft.ts`, signedPath(selected)]) {
      assert.equal(await (await send(request(path), env)).text(), "volume origin");
    }
    for (const path of ["/v1/volumes", `/v1/volumes?ids=${selected}`, `/v1/volumes/${other}`, signedPath(other), "/v1/links/_.signature/file"]) {
      assert.equal(await (await send(request(path), env)).text(), "ECS");
    }
    assert.equal(await (await send(request(`/v1/volumes/${selected}`), { ...env, LEGACY_VOLUMES_ROLLOUT: undefined })).text(), "ECS");
  }
  assert.equal(sidecar.mock.callCount(), 4);
  assert.equal(ecs.mock.callCount(), 12);
});

test("a volume read allowlist changes only GET routing and preserves the existing write rollout", async t => {
  const ecs = t.mock.method(globalThis, "fetch", async () => new Response("ECS"));
  const sidecar = t.mock.fn(async (request: Request) => {
    assert.equal(request.headers.get("authorization"), "Bearer original-key");
    assert.equal(request.headers.get("x-camelrun-volume-origin"), "private origin token");
    assert.equal(request.headers.get("x-agent-runtime-internal"), null);
    return new Response("volume origin");
  });
  const reading = "vol_111111111111111111111111";
  const writing = "vol_222222222222222222222222";
  const other = "vol_333333333333333333333333";
  const signed = (volume: string) => `/v1/links/${Buffer.from(JSON.stringify({ volume })).toString("base64url")}.signature/file`;
  const env = {
    V2: { fetch: async () => new Response(null) }, LEGACY_VOLUMES: { fetch: sidecar },
    LEGACY_VOLUMES_ORIGIN_TOKEN: "private origin token", LEGACY_VOLUMES_ROLLOUT: writing,
    LEGACY_VOLUMES_READ_ROLLOUT: ` ${reading} `,
  };
  for (const host of ["run.camelai.com", "agents.camelai.dev"]) {
    for (const send of [worker.fetch, fetchLegacyApi]) {
      const request = (path: string, method = "GET") => new Request(`https://${host}${path}`, {
        method, headers: { authorization: "Bearer original-key", "x-agent-runtime-internal": "forged" },
      });
      for (const path of [`/v1/volumes/${reading}/files?prefix=src%2F`, signed(reading)]) {
        assert.equal(await (await send(request(path), env)).text(), "volume origin");
        for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
          assert.equal(await (await send(request(path, method), env)).text(), "ECS");
        }
      }
      for (const path of ["/v1/volumes", `/v1/volumes?ids=${reading}`, `/v1/volumes/${other}`, signed(other)]) {
        assert.equal(await (await send(request(path), env)).text(), "ECS");
      }
      assert.equal(await (await send(request(`/v1/volumes/${writing}/files`, "PUT"), env)).text(), "volume origin");
      assert.equal(await (await send(request(`/v1/volumes/${reading}`), { ...env, LEGACY_VOLUMES_READ_ROLLOUT: undefined })).text(), "ECS");
    }
  }
  assert.equal(sidecar.mock.callCount(), 12);
  assert.equal(ecs.mock.callCount(), 68);
});

test("all volume reads includes collections but does not retry ECS on a selected origin failure", async t => {
  const ecs = t.mock.method(globalThis, "fetch", async () => new Response("ECS"));
  const sidecar = t.mock.fn(async () => new Response("volume origin"));
  const env = {
    V2: { fetch: async () => new Response(null) }, LEGACY_VOLUMES: { fetch: sidecar },
    LEGACY_VOLUMES_ORIGIN_TOKEN: "private origin token", LEGACY_VOLUMES_READ_ROLLOUT: "all",
  };
  for (const send of [worker.fetch, fetchLegacyApi]) {
    const url = "https://run.camelai.com/v1/volumes?ids=vol_111111111111111111111111";
    assert.equal(await (await send(new Request(url), env)).text(), "volume origin");
    assert.equal(await (await send(new Request(url, { method: "POST" }), env)).text(), "ECS");
    assert.equal((await send(new Request(url), { ...env, LEGACY_VOLUMES_ORIGIN_TOKEN: undefined })).status, 503);
    const unavailable = { ...env, LEGACY_VOLUMES: { fetch: async () => { throw new Error("unreachable"); } } };
    assert.equal((await send(new Request(url), unavailable)).status, 502);
  }
  assert.equal(sidecar.mock.callCount(), 2);
  assert.equal(ecs.mock.callCount(), 2);
});
