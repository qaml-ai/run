import assert from 'node:assert/strict';
import { contractTest, createContractFixture, toolCall } from '../support.ts';
import { assertToolSchema } from '../../tool-schema-assertions.ts';
import { BUILTINS, builtinDefinitions } from '../../../src/builtins.ts';
import { GENERATE_IMAGE } from '../../../src/images.ts';
import { DECIDE } from '../../../src/decisions.ts';

contractTest('computers', 'tests/tool-schemas.test.ts', 'every runtime tool sent to the model has an object parameters schema', async t => {
  const seen = new Set<string>();
  const r = await createContractFixture(t, { respond: body => {
    for (const tool of body.tools ?? []) {
      assertToolSchema(tool.function.name, tool.function.parameters);
      seen.add(tool.function.name);
    }
    return toolCall('final_output', { answer: 'ok' });
  } });
  // Shell and browser attachments expose different tools; neither needs to be started.
  for (const provider of ['boat', 'browserbase']) {
    const created = await r.call('/v1/agents', { body: {
      builtins: Object.keys(BUILTINS), delegate: { instructions: true },
    } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.id;
    const attached = await r.call('/v1/computers', { body: { agent: id, provider,
      credentials: provider === 'boat' ? { apiKey: 'fixture-key' } : { apiKey: 'fixture-key', projectId: 'fixture-project' },
      leaseSeconds: 600, dailySeconds: 3600 } });
    assert.equal(attached.status, 201, JSON.stringify(attached.json));
    const run = await r.prompt(id, 'Check your tools', undefined, { output: { schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } } });
    assert.equal(run.status, 'completed', JSON.stringify(run.outcome));
  }
  for (const name of ['delegate', 'spawn_agent', 'schedule', 'list_schedules', 'cancel_schedule',
    'read', 'write', 'edit', 'final_output', 'codemode', 'computer_exec', 'computer_start', 'computer_status',
    'computer_stop', 'computer_read_file', 'computer_write_file', 'browser_navigate', 'browser_read',
    'browser_click', 'browser_fill', 'browser_evaluate']) assert.ok(seen.has(name), `Missing coverage: ${name}`);
  // The Workers backend offers its native computer tool whether or not containers are configured.
  if (process.env.CONTRACT_BACKEND === 'workers') assert.ok(seen.has('computer'), 'Missing coverage: computer');
  // Credential-gated tools retain coverage even when this fixture has no provider keys.
  for (const tool of [...builtinDefinitions(Object.keys(BUILTINS)), GENERATE_IMAGE, DECIDE])
    assertToolSchema(tool.name, tool.parameters);
});
