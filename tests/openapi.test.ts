import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openapiDocument } from "../src/api.ts";

test("the committed openapi.json is current (npm run openapi regenerates it)", async () => {
  assert.equal(await readFile(new URL("../openapi.json", import.meta.url), "utf8"), `${JSON.stringify(openapiDocument(), null, 2)}\n`);
});
