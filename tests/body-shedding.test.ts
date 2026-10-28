import { test } from "node:test";
import assert from "node:assert/strict";
import { errorHeaders, HttpError, readBytes, readJson, SHED_BODY_BYTES, shedBodies } from "../src/http.ts";

const body = (text: string) => (async function* () { yield new TextEncoder().encode(text); })();

test("a node short of memory sheds large bodies before reading them, and still reads small ones", async (t) => {
  let short = true;
  shedBodies(() => short);
  t.after(() => shedBodies(() => false));
  let read = false;
  const watched = (async function* () { read = true; yield new TextEncoder().encode("{}"); })();
  const shed = await readBytes(watched, SHED_BODY_BYTES + 1).catch((error: unknown) => error);
  assert.ok(shed instanceof HttpError);
  assert.equal(shed.status, 503);
  assert.match(shed.message, /^BUSY:/);
  assert.equal(errorHeaders(shed)["Retry-After"], "2");
  assert.equal(read, false, "nothing of a shed body is read");
  // A route that allows a small body is served as ever.
  assert.deepEqual(await readJson(body('{"a":1}'), 4096), { a: 1 });
  // Once memory falls, large bodies are read again.
  short = false;
  assert.deepEqual(await readJson(body('{"b":2}'), 8 * 1024 * 1024), { b: 2 });
});
