import test from "node:test";
import assert from "node:assert/strict";
import { modelOutputSchema } from "../src/multi-agent-policy.ts";

test("a sub-agent's output schema as models send it is repaired before it is checked", () => {
  const object = { type: "object", properties: { status: { type: "string" } }, required: ["status"] };
  assert.deepEqual(modelOutputSchema(JSON.stringify(object)), object, "a JSON string");
  assert.deepEqual(modelOutputSchema({ schema: object }), object, "a { schema } wrapper");
  assert.deepEqual(modelOutputSchema({ properties: object.properties, required: ["status"] }), object, "no type (DeepSeek V4.1 Flash)");
  assert.deepEqual(modelOutputSchema(object), object, "a schema as it should be, unchanged");
  assert.equal(modelOutputSchema("not json"), "not json", "left for the check to refuse");
  assert.deepEqual(modelOutputSchema({ type: "string" }), { type: "string" }, "not an object: left for the check to refuse");
});
