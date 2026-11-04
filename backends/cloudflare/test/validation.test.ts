import assert from "node:assert/strict";
import test from "node:test";
import { authorized, body, object, workspacePath } from "../src/validation.ts";

test("workspace paths cannot escape or alias their root", () => {
  assert.equal(workspacePath("notes/report.md"), "/workspace/notes/report.md");
  for (const path of ["../secret", "/secret", "x/../../secret", "x//y", "x/./y", "x\\y", "x\0y"]) {
    assert.throws(() => workspacePath(path));
  }
});

test("auth fails closed without configuration and rejects other credentials", async () => {
  const key = "prototype-test-token-with-at-least-32-characters";
  const request = (value: string) => new Request("https://example.test", { headers: { authorization: value } });
  assert.equal(await authorized(request(`Bearer ${key}`), key), true);
  assert.equal(await authorized(request(`Bearer ${key}x`), key), false);
  assert.equal(await authorized(request(`Bearer ${key}`), undefined), false);
});

test("JSON size is bounded even without content-length", async () => {
  const request = (text: string) => new Request("https://example.test", { method: "POST", body: text });
  assert.deepEqual(await body(request('{"text":"ok"}')), { text: "ok" });
  await assert.rejects(body(request('"' + "x".repeat(50) + '"'), 32), /too large/);
  await assert.rejects(body(request("{")), /Invalid JSON/);
  assert.throws(() => object({ tools: [] }, ["text"]), /Unsupported/);
});
