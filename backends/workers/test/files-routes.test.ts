import assert from "node:assert/strict";
import test from "node:test";
import { retiredVolumes } from "../src/files.ts";
import { workersVoicePaths } from "../src/voice/calls/openapi.ts";
import { workersOpenApi } from "../src/workers-openapi.ts";

test("all retired volume paths return 410 and similarly named routes fall through", async () => {
  for (const path of ["/v1/volumes", "/v1/volumes/", "/v1/volumes/old/files/a/b"]) {
    const response = retiredVolumes(path);
    assert.equal(response?.status, 410);
    assert.deepEqual(await response.json(), { error: "Volumes are replaced by repos: use /v1/repos", code: "gone" });
  }
  for (const path of ["/v1/volumes-extra", "/v1/repos", "/v1/images"]) assert.equal(retiredVolumes(path), undefined);
});

test("Workers OpenAPI replaces live volume operations with 410 and the voice paths with its own, without changing the source", () => {
  const source = { paths: { "/v1/volumes": { post: {} }, "/v1/volumes/{id}/files": { get: {} }, "/v1/agents": { get: {} }, "/v1/voice/sessions": { post: {} } } };
  const { paths } = workersOpenApi(source);
  const voice = workersVoicePaths();
  assert.deepEqual(Object.keys(paths).sort(), ["/v1/agents", ...Object.keys(voice), "/v1/volumes", "/v1/volumes/{path}"].sort());
  assert.deepEqual(paths["/v1/voice/sessions"], voice["/v1/voice/sessions"], "the Workers call shape replaces the source's voice session paths");
  assert.deepEqual(source.paths["/v1/voice/sessions"], { post: {} });
  assert.deepEqual(paths["/v1/agents"], source.paths["/v1/agents"]);
  assert.match(JSON.stringify(paths["/v1/volumes"]), /"410"/);
  assert.ok(source.paths["/v1/volumes/{id}/files"]);
});
