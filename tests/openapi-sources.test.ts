import { test } from "node:test";
import assert from "node:assert/strict";
import { stringify as yaml } from "yaml";
import { listen, runtime, toolCall, toolResults, type T } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

/** A small pet store: its spec at /openapi.json (and .yaml), its API under /v1. */
async function petStore(t: T) {
  const seen: { method: string; url: string; authorization?: string; body?: unknown }[] = [];
  const pets: Record<string, { id: number; name: string }> = { "7": { id: 7, name: "Rex" } };
  let base = "";
  const spec = () => ({
    openapi: "3.0.3", info: { title: "Pets", version: "1" }, servers: [{ url: `${base}/v1` }],
    paths: {
      "/pets": {
        get: { operationId: "listPets", summary: "List pets", parameters: [
          { name: "limit", in: "query", schema: { type: "integer", format: "int32" } },
          { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } },
        ], responses: { 200: { description: "ok" } } },
        post: { operationId: "createPet", summary: "Add a pet", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewPet" } } } }, responses: { 201: { description: "made" } } },
      },
      "/pets/{petId}": {
        parameters: [{ name: "petId", in: "path", required: true, schema: { type: "integer" } }],
        get: { operationId: "getPet", summary: "Get a pet", responses: { 200: { description: "ok" } } },
        delete: { operationId: "deletePet", responses: { 204: { description: "gone" } } },
      },
      "/pets/{petId}/notes": {
        post: { operationId: "addNote", parameters: [{ name: "petId", in: "path", required: true, schema: { type: "integer" } }], requestBody: { content: { "application/x-www-form-urlencoded": { schema: { type: "object", properties: { text: { type: "string" }, tags: { type: "array", items: { type: "string" } }, meta: { type: "object" } } } } } }, responses: { 200: { description: "ok" } } },
      },
      "/upload": { post: { operationId: "uploadPhoto", requestBody: { content: { "multipart/form-data": { schema: { type: "object" } } } }, responses: { 200: { description: "ok" } } } },
    },
    components: { schemas: {
      NewPet: { type: "object", required: ["name"], properties: { name: { type: "string" }, nickname: { type: "string", nullable: true }, parent: { $ref: "#/components/schemas/NewPet" } } },
    } },
  });
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const path = new URL(req.url!, "http://x").pathname;
    if (path === "/openapi.json") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(spec())); return; }
    if (path === "/openapi.yaml") { res.writeHead(200, { "Content-Type": "application/yaml" }).end(yaml(spec())); return; }
    if (path === "/swagger.json") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ swagger: "2.0", paths: {} })); return; }
    const form = req.headers["content-type"] === "application/x-www-form-urlencoded";
    seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, ...(text ? { body: form ? text : JSON.parse(text) } : {}) });
    const json = (status: number, value: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    const match = path.match(/^\/v1\/pets\/(\d+)$/);
    if (path === "/v1/pets" && req.method === "GET") json(200, Object.values(pets));
    else if (path === "/v1/pets" && req.method === "POST") { const pet = { id: 8, name: JSON.parse(text).name }; pets["8"] = pet; json(201, pet); }
    else if (path === "/v1/pets/7/notes") json(200, { noted: true });
    else if (match && pets[match[1]]) json(200, pets[match[1]]);
    else json(404, { error: "no such pet" });
  });
  base = url;
  return { url, seen };
}

test("an OpenAPI spec's operations are tools: requests built from the spec, data back, errors as tool errors", async t => {
  const store = await petStore(t);
  const r = await runtime(t, (_body, index) => [
    toolCall("pets__listPets", { limit: 2, tags: ["a", "b"] }),
    toolCall("js_exec", { code: "const pet = await tools.pets__getPet({ petId: 7 }); return pet.name.toUpperCase();" }),
    toolCall("pets__createPet", { body: { name: "Fido" } }),
    toolCall("pets__getPet", { petId: 404 }),
    toolCall("pets__addNote", { petId: 7, body: { text: "good dog", tags: ["a", "b"], meta: { by: "ada" } } }),
  ][index] ?? { role: "assistant", content: "done" }, LOCAL);
  const created = await r.call("/v1/definitions", { body: { name: "Pets", openApi: [{ name: "pets", spec: `${store.url}/openapi.json`, auth: { type: "bearer", token: "s3cret" }, denyTools: ["deletePet"], exposure: "both" }] } });
  assert.equal(created.status, 201, created.text);
  const [source] = created.json.openApi;
  assert.deepEqual(source.tools, ["listPets", "createPet", "getPet", "addNote"], "the multipart operation is left out, and deletePet denied");
  assert.equal(source.baseUrl, `${store.url}/v1`);
  assert.deepEqual(source.auth, { type: "bearer" });
  assert.equal(created.text.includes("s3cret") || JSON.stringify((await r.db.query("select spec from definitions")).rows).includes("s3cret"), false, "the token is sealed");

  const agent = (await r.call("/v1/agents", { body: { definition: created.json.id } })).json;
  assert.equal((await r.prompt(agent.id, "look after the pets")).outcome.result.reply, "done");
  const offered = r.model.bodies[0].tools.map((tool: any) => tool.function.name);
  assert.deepEqual(offered.filter((name: string) => name.startsWith("pets__")).sort(), ["pets__addNote", "pets__createPet", "pets__getPet", "pets__listPets"]);
  const createPet = r.model.bodies[0].tools.find((tool: any) => tool.function.name === "pets__createPet").function.parameters;
  assert.deepEqual(createPet.properties.body.properties.nickname.type, ["string", "null"], "3.0's nullable becomes a JSON Schema type");
  assert.deepEqual(createPet.properties.body.properties.parent, {}, "a schema that refers back to itself stops");

  assert.match(toolResults(r.model.bodies[1]).at(-1), /"name":"Rex"/);
  assert.match(toolResults(r.model.bodies[2]).at(-1), /REX/, "code gets the data");
  assert.match(toolResults(r.model.bodies[3]).at(-1), /"id":8/);
  assert.match(toolResults(r.model.bodies[4]).at(-1), /GET \/pets\/\{petId\} answered HTTP 404: \{"error":"no such pet"\}/);
  assert.match(toolResults(r.model.bodies[5]).at(-1), /noted/);
  assert.deepEqual(store.seen.map(({ method, url }) => `${method} ${url}`), ["GET /v1/pets?limit=2&tags=a&tags=b", "GET /v1/pets/7", "POST /v1/pets", "GET /v1/pets/404", "POST /v1/pets/7/notes"]);
  assert.deepEqual(store.seen[2].body, { name: "Fido" });
  assert.equal(decodeURIComponent(store.seen[4].body as string), "text=good+dog&tags[]=a&tags[]=b&meta[by]=ada", "a form body, nested values in brackets");
  assert.deepEqual([...new Set(store.seen.map(entry => entry.authorization))], ["Bearer s3cret"]);
});

test("OpenAPI sources are checked when the definition is saved", async t => {
  const store = await petStore(t);
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), LOCAL);
  const save = (openApi: unknown[], extra: object = {}) => r.call("/v1/definitions", { body: { name: "Pets", openApi, ...extra } });
  const yamlSpec = await save([{ name: "pets", spec: `${store.url}/openapi.yaml`, allowTools: ["getPet"] }]);
  assert.equal(yamlSpec.status, 201, yamlSpec.text);
  assert.deepEqual(yamlSpec.json.openApi[0].tools, ["getPet"]);
  const inline = await save([{ name: "pets", spec: { openapi: "3.1.0", info: { title: "x", version: "1" }, paths: { "/ping": { get: { operationId: "ping" } } } }, baseUrl: `${store.url}/v1` }]);
  assert.equal(inline.status, 201, inline.text);
  assert.equal(inline.json.openApi[0].spec, undefined);
  // Edited without its spec (which the API does not return), a source keeps its operations.
  const edited = await r.call(`/v1/definitions/${inline.json.id}`, { method: "PATCH", body: { openApi: [{ name: "pets", timeoutMs: 5000 }] } });
  assert.equal(edited.status, 200, edited.text);
  assert.deepEqual([edited.json.openApi[0].tools, edited.json.openApi[0].timeoutMs], [["ping"], 5000]);
  for (const [openApi, why] of [
    [[{ name: "pets", spec: `${store.url}/swagger.json` }], /Only OpenAPI 3/],
    [[{ name: "pets", spec: `${store.url}/missing.json` }], /HTTP 404/],
    [[{ name: "pets", spec: { openapi: "3.0.0", paths: {} }, baseUrl: `${store.url}/v1` }], /no operations/],
    [[{ name: "pets", spec: { openapi: "3.0.0", paths: { "/a": { get: {} } } } }], /no server; give baseUrl/],
    [[{ name: "pets", spec: `${store.url}/openapi.json`, allowTools: ["nothing"] }], /no operations/],
  ] as const) {
    const refused = await save([...openApi]);
    assert.equal(refused.status, 400, refused.text);
    assert.match(refused.json.error, why);
  }
  const clash = await save([{ name: "pets", spec: `${store.url}/openapi.json` }], { mcpServers: [{ name: "pets", url: `${store.url}/mcp` }] });
  assert.equal(clash.status, 400);
  assert.match(clash.json.error, /names both an MCP server and an OpenAPI source/);
});
