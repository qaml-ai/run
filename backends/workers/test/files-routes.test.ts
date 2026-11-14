import assert from "node:assert/strict";
import test from "node:test";
import { retiredVolumes } from "../src/files.ts";
import { workersOpenApi } from "../src/workers-openapi.ts";

test("all retired volume paths return 410 and similarly named routes fall through", async () => {
  for (const path of ["/v1/volumes", "/v1/volumes/", "/v1/volumes/old/files/a/b"]) {
    const response = retiredVolumes(path);
    assert.equal(response?.status, 410);
    assert.deepEqual(await response.json(), { error: "Volumes are replaced by repos: use /v1/repos", code: "gone" });
  }
  for (const path of ["/v1/volumes-extra", "/v1/repos", "/v1/images"]) assert.equal(retiredVolumes(path), undefined);
});

test("Workers OpenAPI replaces live volume operations with 410 without changing the source", () => {
  const source = { paths: { "/v1/volumes": { post: {} }, "/v1/volumes/{id}/files": { get: {} }, "/v1/agents": { get: {} } } };
  const { paths } = workersOpenApi(source);
  assert.deepEqual(Object.keys(paths).sort(), ["/v1/agents", "/v1/volumes", "/v1/volumes/{path}"]);
  assert.deepEqual(paths["/v1/agents"], source.paths["/v1/agents"]);
  assert.match(JSON.stringify(paths["/v1/volumes"]), /"410"/);
  assert.ok(source.paths["/v1/volumes/{id}/files"]);
});
