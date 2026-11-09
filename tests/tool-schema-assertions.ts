import assert from 'node:assert/strict';

/** Provider compatibility applies to the root only: nested unions remain valid. */
export function assertToolSchema(name: string, schema: any) {
  assert.equal(schema?.type, 'object', `${name}: parameters must be a top-level object`);
  for (const keyword of ['anyOf', 'oneOf', 'allOf'])
    assert.equal(Object.hasOwn(schema, keyword), false, `${name}: no top-level ${keyword}`);
}
